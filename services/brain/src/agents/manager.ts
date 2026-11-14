import { execFile, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentOverview, AgentProfile, AgentProfileInput, AgentRuntime, AgentTask, AgentTaskInput, AgentTaskStatus, SseEvent } from '@pi-amadeus/shared'
import { runAgentTurn } from '../agentTurn.ts'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { resolveBashConfirm } from '../tools/confirm.ts'
import { AGENT_CATALOG, agentEnvironment, discoverAgents, executablePath } from './catalog.ts'
import { AgentStore } from './store.ts'

const MAX_CONCURRENT = 3
const MAX_QUEUED = 100
const OUTPUT_BYTES = 256 * 1024
const EVENT_OUTPUT_BYTES = 16 * 1024
const TASK_TIMEOUT_MS = 30 * 60 * 1000
const FINAL = new Set<AgentTaskStatus>(['completed', 'failed', 'cancelled', 'interrupted'])
const RUNTIMES = new Set<AgentRuntime>(['brain', ...Object.keys(AGENT_CATALOG) as (keyof typeof AGENT_CATALOG)[], 'custom'])
const MANAGERS = new Set<string>()

type OutputStream = 'stdout' | 'stderr' | 'assistant'
interface ActiveRun {
  taskId: string
  cwd: string
  controller: AbortController
  done: Promise<void>
  child?: ChildProcessWithoutNullStreams
  termination?: Promise<void>
  forced?: { status: 'cancelled' | 'interrupted' | 'failed'; error: string | null }
  timer?: NodeJS.Timeout
  outputTimer?: NodeJS.Timeout
  approvalTimer?: NodeJS.Timeout
  pendingOutput: string
  output: string
  outputStream: OutputStream
  truncated: boolean
  brainOutputBytes: number
}

export class AgentError extends Error {
  readonly status: 400 | 404 | 409
  constructor(status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'AgentError'
    this.status = status
  }
}

export function agentObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError(400, '请求体必须是 JSON 对象')
  return value as Record<string, unknown>
}

export function agentString(value: unknown, name: string, limit = 200, empty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > limit || (!empty && !value.trim())) {
    throw new AgentError(400, `${name} 必须是${empty ? '' : '非空'}字符串（最多 ${limit} 字符，不能含 NUL）`)
  }
  return value
}

export function agentPosition(value: unknown): { x: number; y: number } {
  const position = agentObject(value)
  if (typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1_000_000 || Math.abs(position.y) > 1_000_000) {
    throw new AgentError(400, 'position.x/y 必须是有限坐标（绝对值不超过 1000000）')
  }
  return { x: position.x, y: position.y }
}

/** 按 UTF-8 字节保留尾部，不从续字节中间切开中文或 emoji。 */
function tail(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= bytes) return text
  let start = buffer.length - bytes
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}

function overlaps(a: string, b: string): boolean {
  const within = (parent: string, child: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  }
  return within(a, b) || within(b, a)
}

function assertSafeArgs(args: string[]): void {
  const bypass = /^--(?:dangerously[-_]|dangerous[-_]|yolo(?:=|$)|full-auto(?:=|$)|allow-all(?:[-=]|$)|auto-approve(?:[-=]|$)|skip-permissions(?:=|$)|no-sandbox(?:=|$)|sandbox=none)/i
  if (args.some((arg, i) => bypass.test(arg) || /^(?:--permission-mode|--approval-mode)=(?:bypassPermissions|yolo)$/i.test(arg) || (/^--(?:permission-mode|approval-mode)$/i.test(arg) && /^(?:bypassPermissions|yolo)$/i.test(args[i + 1] ?? '')))) {
    throw new AgentError(400, '不能配置跳过权限确认或沙箱的参数')
  }
}

async function directory(path: string): Promise<string> {
  agentString(path, 'cwd', 4096)
  if (!isAbsolute(path)) throw new AgentError(400, 'cwd 必须是绝对目录路径')
  try {
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('不是目录')
    return canonical
  } catch {
    throw new AgentError(400, 'cwd 不存在或不是可访问的目录')
  }
}

/** 任务执行属于 manager，不属于 HTTP/SSE 请求；观察者断线绝不触发取消。 */
export class AgentManager {
  private readonly cfg: BrainConfig
  private readonly db: Db
  private readonly store: AgentStore
  private readonly tasks = new Map<string, AgentTask>()
  private readonly active = new Map<string, ActiveRun>()
  private initialized = false
  private stopping = false
  private pumpScheduled = false
  private shutdownPromise: Promise<void> | null = null

  constructor(cfg: BrainConfig, db: Db, store: AgentStore) {
    this.cfg = cfg
    this.db = db
    this.store = store
  }

  async init(): Promise<void> {
    if (this.initialized) return
    if (this.stopping) throw new AgentError(409, 'Agent 管理器已关闭')
    if (MANAGERS.has(this.store.path)) throw new AgentError(409, '此数据库已有 Agent 管理器')
    this.store.claimScheduler()
    MANAGERS.add(this.store.path)
    try {
      if (!this.store.getProfile('amadeus')) {
        const now = Date.now()
        this.store.saveProfile({ id: 'amadeus', name: 'Amadeus', runtime: 'brain', command: '', args: [], promptMode: 'stdin', instructions: '你是隔离的任务执行助手。只处理当前任务，遵守工具权限，不更改用户认证、权限或模型配置。', model: '', enabled: true, allowRemote: false, createdAt: now, updatedAt: now })
      }
      for (const task of this.store.listAllTasks()) {
        this.tasks.set(task.id, task)
        if (task.status === 'running' || task.status === 'waiting_approval' || task.status === 'queued') {
          // 重启后的执行与排队授权已失去现场上下文；保留日志，统一 interrupted，禁止盲目重跑收费任务。
          this.transition(task, 'interrupted', '服务重启中断了执行；可创建续接任务继续')
        }
      }
      // 数据恢复完成后才启动队列，避免恢复过程中执行了尚未检查的依赖。
      this.initialized = true
      this.schedulePump()
    } catch (error) {
      MANAGERS.delete(this.store.path)
      this.store.releaseScheduler()
      throw error
    }
  }

  private ready(): void {
    if (!this.initialized || this.stopping) throw new AgentError(409, 'Agent 管理器尚未就绪或正在关闭')
  }

  async overview(userId: string): Promise<AgentOverview> {
    this.ready()
    agentString(userId, 'userId')
    if (!await this.db.getUser(userId)) throw new AgentError(404, '用户不存在')
    return { profiles: this.store.listProfiles(), discovered: await discoverAgents(), tasks: this.store.listTasks(userId), maxConcurrent: MAX_CONCURRENT }
  }

  getTask(id: string, userId: string): AgentTask {
    agentString(id, 'id')
    agentString(userId, 'userId')
    const task = this.tasks.get(id) ?? this.store.getTask(id)
    if (!task || task.userId !== userId) throw new AgentError(404, '任务不存在')
    return structuredClone(task)
  }

  async saveProfile(input: AgentProfileInput, id?: string): Promise<AgentProfile> {
    this.ready()
    const body = agentObject(input)
    const runtime = agentString(body.runtime, 'runtime') as AgentRuntime
    if (!RUNTIMES.has(runtime)) throw new AgentError(400, '不支持的 Agent runtime')
    const name = agentString(body.name, 'name', 100).trim()
    const instructions = agentString(body.instructions, 'instructions', 64_000, true)
    const model = agentString(body.model, 'model', 200, true)
    let command = agentString(body.command, 'command', 4096, true)
    if (body.promptMode !== 'stdin' && body.promptMode !== 'argument') throw new AgentError(400, 'promptMode 必须为 stdin 或 argument')
    let promptMode: AgentProfile['promptMode'] = body.promptMode
    if (typeof body.enabled !== 'boolean' || typeof body.allowRemote !== 'boolean') throw new AgentError(400, 'enabled/allowRemote 必须为布尔值')
    if (!Array.isArray(body.args) || body.args.length > 128) throw new AgentError(400, 'args 必须是最多 128 项的字符串数组')
    let args = body.args.map((arg) => agentString(arg, 'args[]', 16_384, true))
    if (args.join('').length > 64_000) throw new AgentError(400, 'args 总长度不能超过 64000 字符')
    if (id) {
      agentString(id, 'id')
      if (!this.store.getProfile(id)) throw new AgentError(404, 'Agent 配置不存在')
    }
    if (id === 'amadeus' && runtime !== 'brain') throw new AgentError(409, '内置 Amadeus 必须使用 brain runtime')
    if (runtime === 'brain') {
      if (command || args.length) throw new AgentError(400, 'brain 不接受外部可执行命令或参数')
      if (promptMode !== 'stdin') throw new AgentError(400, 'brain 使用 stdin 提示词模式')
    } else if (runtime === 'custom') {
      if (!isAbsolute(command)) throw new AgentError(400, 'custom.command 必须是明确的绝对可执行文件路径')
      const path = await executablePath(command)
      if (!path) throw new AgentError(400, 'custom.command 不存在或不可执行（不支持 shell/bat/cmd 包装）')
      command = path
    } else {
      const spec = AGENT_CATALOG[runtime]
      command = command || runtime
      if (!isAbsolute(command) && command !== runtime) throw new AgentError(400, '原生 Agent 命令必须为 runtime 名称或绝对可执行路径')
      if (args.length === 0) {
        args = [...spec.args]
        promptMode = spec.promptMode
      }
    }
    assertSafeArgs(args)
    if (args.some((arg) => arg.includes('{prompt}') && arg !== '{prompt}')) throw new AgentError(400, '{prompt} 必须是独立完整的 argv 元素')
    const placeholders = args.filter((arg) => arg === '{prompt}').length
    if ((promptMode === 'argument' && placeholders !== 1) || (promptMode === 'stdin' && placeholders !== 0)) throw new AgentError(400, 'argument 模式必须恰好有一个 {prompt} 参数；stdin 模式不能有占位符')
    this.ready()
    const previous = id ? this.store.getProfile(id) : null
    if (id && !previous) throw new AgentError(404, 'Agent 配置已被删除')
    const profile: AgentProfile = { id: id ?? randomUUID(), name, runtime, command, args, promptMode, instructions, model, enabled: body.enabled, allowRemote: body.allowRemote, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() }
    this.store.saveProfile(profile)
    return structuredClone(profile)
  }

  deleteProfile(id: string): void {
    this.ready()
    agentString(id, 'id')
    if (id === 'amadeus') throw new AgentError(409, '不能删除内置 Amadeus，可将其停用')
    if (!this.store.getProfile(id)) throw new AgentError(404, 'Agent 配置不存在')
    if ([...this.tasks.values()].some((task) => task.agentId === id && !FINAL.has(task.status))) throw new AgentError(409, '仍有排队或执行中的任务，不能删除此 Agent')
    this.store.deleteProfile(id)
  }

  async createTask(input: AgentTaskInput, remote = false): Promise<AgentTask> {
    this.ready()
    const body = agentObject(input)
    const userId = agentString(body.userId, 'userId')
    const requestId = agentString(body.requestId, 'requestId')
    const agentId = agentString(body.agentId, 'agentId')
    const title = agentString(body.title, 'title', 200).trim()
    const prompt = agentString(body.prompt, 'prompt', 64_000)
    const cwdInput = agentString(body.cwd, 'cwd', 4096, true)
    const optional = (key: string): string | null => body[key] === undefined ? null : agentString(body[key], key)
    const missionId = optional('missionId')
    const parentTaskId = optional('parentTaskId')
    const resumeOf = optional('resumeOf')
    if (body.dependsOn !== undefined && (!Array.isArray(body.dependsOn) || body.dependsOn.length > MAX_QUEUED)) throw new AgentError(400, 'dependsOn 必须是最多 100 个任务 id 的数组')
    const dependsOn = [...new Set(((body.dependsOn ?? []) as unknown[]).map((id) => agentString(id, 'dependsOn[]')))]
    if (parentTaskId && !dependsOn.includes(parentTaskId)) dependsOn.push(parentTaskId)
    const existing = this.store.findRequest(userId, requestId)
    if (existing) return existing
    const selected = this.store.getProfile(agentId)
    const effectiveCwd = !cwdInput && selected?.runtime === 'brain' ? this.cfg.tools.bashCwd : cwdInput
    const [cwd, user] = await Promise.all([directory(effectiveCwd), this.db.getUser(userId)])
    if (!user) throw new AgentError(404, '用户不存在')
    this.ready()
    // 两个网络重试可能同时等 realpath；所有 await 之后再检查幂等键与队列容量。
    const retried = this.store.findRequest(userId, requestId)
    if (retried) return retried
    const profile = this.store.getProfile(agentId)
    if (!profile || !profile.enabled) throw new AgentError(404, 'Agent 不存在或已停用')
    if (remote && !profile.allowRemote) throw new AgentError(409, '该 Agent 尚未由本机所有者允许远程执行')
    for (const id of dependsOn) this.getTask(id, userId)
    if (resumeOf && !FINAL.has(this.getTask(resumeOf, userId).status)) throw new AgentError(409, '只能续接已结束或已中断的任务')
    if ([...this.tasks.values()].filter((task) => task.status === 'queued').length >= MAX_QUEUED) throw new AgentError(409, '排队任务已达 100 个，请先停止或等待已有任务')
    const now = Date.now()
    const parent = parentTaskId ? this.getTask(parentTaskId, userId) : null
    const task: AgentTask = {
      id: randomUUID(), userId, agentId, agentName: profile.name, runtime: profile.runtime,
      title, prompt, cwd, status: 'queued', output: '', error: null, sessionId: randomUUID(),
      missionId: missionId ?? parent?.missionId ?? randomUUID(), parentTaskId, resumeOf, dependsOn,
      position: { x: 80 + (this.tasks.size % 4) * 300, y: 80 + Math.floor((this.tasks.size % 20) / 4) * 220 }, revision: 1,
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, pendingApproval: null
    }
    // 新请求 → queued 与幂等键同事务写入，先持久化再允许调度。
    this.store.saveTaskEvent(task, 'status', { status: task.status, error: null, revision: task.revision }, requestId, remote)
    this.tasks.set(task.id, task)
    this.schedulePump()
    return structuredClone(task)
  }

  async stop(id: string, userId: string): Promise<AgentTask> {
    this.ready()
    const task = this.getTask(id, userId)
    if (FINAL.has(task.status)) return task
    const run = this.active.get(id)
    if (run) {
      this.abortRun(run, 'cancelled', null)
      await run.done
    } else {
      // queued → cancelled 不启动任何进程；依赖它的排队任务随后也会取消。
      this.transition(this.tasks.get(id)!, 'cancelled', null)
      this.schedulePump()
    }
    return this.getTask(id, userId)
  }

  async resume(id: string, userId: string, prompt: string, requestId: string, agentId?: string, remote = false): Promise<AgentTask> {
    const previous = this.getTask(id, userId)
    agentString(prompt, 'prompt', 64_000, true)
    agentString(requestId, 'requestId')
    const retry = this.store.findRequest(userId, requestId)
    if (retry) return retry
    if (!FINAL.has(previous.status)) throw new AgentError(409, '任务尚未结束，请先停止再续接')
    return this.createTask({ userId, agentId: agentId ?? previous.agentId, title: `${previous.title.slice(0, 190)}（续接）`, prompt: prompt.trim() || '继续完成前一个任务，保留已有结果。', cwd: previous.cwd, requestId, resumeOf: previous.id, missionId: previous.missionId }, remote)
  }

  async approve(
    id: string,
    userId: string,
    approved: boolean,
    expected: { turnId: string; toolCallId: string }
  ): Promise<AgentTask> {
    this.ready()
    if (typeof approved !== 'boolean') throw new AgentError(400, 'approved 必须是布尔值')
    const expectedTurnId = agentString(expected?.turnId, 'turnId', 256)
    const expectedToolCallId = agentString(expected?.toolCallId, 'toolCallId', 256)
    const task = this.getTask(id, userId)
    const run = this.active.get(id)
    const pending = task.pendingApproval
    if (task.status !== 'waiting_approval' || !pending || !run || run.controller.signal.aborted) throw new AgentError(409, '没有可处理的命令确认')
    if (pending.turnId !== expectedTurnId || pending.toolCallId !== expectedToolCallId) {
      // 旧确认卡只能拒绝，绝不能把同一任务后来出现的另一条命令放行。
      throw new AgentError(409, '这条命令确认已过期，请刷新任务后再试')
    }
    if (pending.expiresAt <= Date.now()) {
      this.clearApproval(run, 'timeout')
      throw new AgentError(409, '命令确认已过期')
    }
    const result = resolveBashConfirm(expectedTurnId, expectedToolCallId, approved)
    if (!result.ok) {
      this.clearApproval(run, 'expired')
      throw new AgentError(409, '命令确认已结束')
    }
    // waiting_approval → running：批准或拒绝都要把结果交回原回合，不另开执行。
    this.clearApproval(run, approved ? 'approved' : 'denied')
    return this.getTask(id, userId)
  }

  move(id: string, userId: string, position: { x: number; y: number }, revision: number): AgentTask {
    this.ready()
    const task = this.getTask(id, userId)
    const nextPosition = agentPosition(position)
    if (!Number.isSafeInteger(revision) || revision < 1) throw new AgentError(400, 'revision 必须为正整数')
    if (task.revision !== revision) throw new AgentError(409, '任务已更新，请刷新后重试位置修改')
    const next = { ...task, position: nextPosition, revision: task.revision + 1, updatedAt: Date.now() }
    this.store.saveTaskEvent(next, 'position', { position: nextPosition, revision: next.revision })
    this.tasks.set(id, next)
    return structuredClone(next)
  }

  private transition(task: AgentTask, status: AgentTaskStatus, error: string | null = null): AgentTask {
    const now = Date.now()
    const next: AgentTask = { ...task, status, error, revision: task.revision + 1, updatedAt: now, pendingApproval: status === 'waiting_approval' ? task.pendingApproval : null, startedAt: status === 'running' ? task.startedAt ?? now : task.startedAt, finishedAt: FINAL.has(status) ? now : null }
    // 所有生命周期迁移先写事务再广播；终态保留 output，不能被迟到的流事件复活。
    this.store.saveTaskEvent(next, 'status', { status, error, revision: next.revision })
    this.tasks.set(next.id, next)
    return next
  }

  private schedulePump(): void {
    if (this.pumpScheduled || !this.initialized || this.stopping) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      if (this.stopping) return
      try { this.pump() } catch (error) {
        console.error('[agents] 无法调度持久化队列：', error instanceof Error ? error.message : error)
      }
    })
  }

  private pump(): void {
    let cancelled: boolean
    do {
      cancelled = false
      for (const task of this.tasks.values()) {
        if (task.status !== 'queued') continue
        const deps = task.dependsOn.map((id) => this.tasks.get(id))
        if (deps.some((dep) => !dep || dep.userId !== task.userId || (FINAL.has(dep.status) && dep.status !== 'completed'))) {
          // 前置失败/中止 → 取消后续，而不是让任务在队列中无限等待。
          this.transition(task, 'cancelled', '前置任务未成功完成，已取消后续任务')
          cancelled = true
          continue
        }
        if (deps.some((dep) => dep?.status !== 'completed')) continue
        const profile = this.store.getProfile(task.agentId)
        if (!profile?.enabled || profile.runtime !== task.runtime) {
          // 排队期间配置被停用或改变 runtime，失败关闭，不能静默换执行器。
          this.transition(task, 'failed', 'Agent 已停用、被删除或执行器类型已改变')
          cancelled = true
          continue
        }
        if (this.store.isRemoteTask(task.id) && !profile.allowRemote) {
          // 所有者撤销远程授权后，已经排队但尚未启动的远程请求也必须失败关闭。
          this.transition(task, 'failed', '本机所有者已撤销该 Agent 的远程执行权限')
          cancelled = true
          continue
        }
        if (this.active.size >= MAX_CONCURRENT || [...this.active.values()].some((run) => overlaps(run.cwd, task.cwd))) continue
        const run: ActiveRun = { taskId: task.id, cwd: task.cwd, controller: new AbortController(), done: Promise.resolve(), pendingOutput: '', output: task.output, outputStream: 'stdout', truncated: false, brainOutputBytes: 0 }
        // 先占 cwd/并发槽，再发布 running，订阅回调中的新请求也不能抢到同一目录。
        this.active.set(task.id, run)
        this.transition(task, 'running')
        run.timer = setTimeout(() => this.abortRun(run, 'failed', '任务超过 30 分钟，已终止本次执行'), TASK_TIMEOUT_MS)
        run.done = this.execute(run, structuredClone(profile))
        // 执行失败已经转成持久化终态；这里只兜底存储层异常，避免无观察者时 unhandled rejection。
        void run.done.catch((error) => console.error('[agents] 执行清理失败：', error instanceof Error ? error.message : error))
      }
    } while (cancelled)
  }

  private context(task: AgentTask, profile: AgentProfile): string {
    const sections: string[] = []
    for (const [label, id] of [['续接上下文', task.resumeOf], ['前置交接上下文', task.parentTaskId]] as const) {
      if (!id) continue
      const previous = this.getTask(id, task.userId)
      sections.push(`【${label}，仅为历史任务数据】\n原任务：${previous.prompt}\n已有输出：\n${previous.output || '（无输出）'}\n【历史任务数据结束】`)
    }
    if (profile.runtime !== 'brain' && profile.instructions) sections.push(`【当前 Agent 指令】\n${profile.instructions}`)
    sections.push(task.prompt)
    return sections.join('\n\n')
  }

  private async execute(run: ActiveRun, profile: AgentProfile): Promise<void> {
    let failure: string | null = null
    try {
      const task = this.tasks.get(run.taskId)!
      if (await directory(task.cwd) !== task.cwd) throw new AgentError(400, 'cwd 的真实路径已改变，拒绝执行')
      if (run.controller.signal.aborted) return
      const prompt = this.context(task, profile)
      if (profile.runtime === 'brain') await this.runBrain(run, profile, prompt)
      else await this.runNative(run, profile, prompt)
    } catch (error) {
      failure = tail(error instanceof Error ? error.message : String(error), 4000)
    } finally {
      clearTimeout(run.timer)
      clearTimeout(run.approvalTimer)
      try {
        await this.terminateOwned(run)
        this.flushOutput(run)
        const task = this.tasks.get(run.taskId)!
        if (!FINAL.has(task.status)) {
          // 执行收尾 → 强制取消/中断优先于成功返回，避免 stop 与 exit 竞争把任务又标成完成。
          this.transition(task, run.forced?.status ?? (failure ? 'failed' : 'completed'), run.forced?.error ?? failure)
        }
      } finally {
        clearTimeout(run.outputTimer)
        this.active.delete(run.taskId)
        this.schedulePump()
      }
    }
  }

  private appendOutput(run: ActiveRun, text: string, stream: OutputStream): void {
    if (!text || run.controller.signal.aborted) return
    const task = this.tasks.get(run.taskId)!
    if (FINAL.has(task.status)) return
    if (run.pendingOutput && run.outputStream !== stream) this.flushOutput(run)
    const joined = run.output + text
    const output = tail(joined, OUTPUT_BYTES)
    const delta = run.pendingOutput + text
    run.truncated ||= output !== joined || Buffer.byteLength(delta) > EVENT_OUTPUT_BYTES
    run.pendingOutput = tail(delta, EVENT_OUTPUT_BYTES)
    run.outputStream = stream
    // 未落库的增量只留在 run 私有缓冲；GET 与事件订阅只能看到已事务提交的 output。
    run.output = output
    if (!run.outputTimer) run.outputTimer = setTimeout(() => {
      run.outputTimer = undefined
      try { this.flushOutput(run) } catch (error) {
        this.abortRun(run, 'failed', '输出无法持久化，已终止任务以避免丢失结果')
        console.error('[agents] 日志写入失败：', error instanceof Error ? error.message : error)
      }
    }, 100)
  }

  private flushOutput(run: ActiveRun): void {
    clearTimeout(run.outputTimer)
    run.outputTimer = undefined
    if (!run.pendingOutput) return
    const current = this.tasks.get(run.taskId)!
    const task = { ...current, output: run.output, revision: current.revision + 1, updatedAt: Date.now() }
    this.store.saveTaskEvent(task, 'output', { delta: run.pendingOutput, stream: run.outputStream, truncated: run.truncated, revision: task.revision })
    this.tasks.set(task.id, task)
    run.pendingOutput = ''
    run.truncated = false
  }

  private async runBrain(run: ActiveRun, profile: AgentProfile, prompt: string): Promise<void> {
    const task = this.tasks.get(run.taskId)!
    const iterator = runAgentTurn({ cfg: this.cfg, db: this.db, userId: task.userId, sessionId: task.sessionId, channel: 'desktop', mode: 'text', content: prompt, signal: run.controller.signal, isolated: true, instructions: profile.instructions, model: profile.model || undefined, cwd: task.cwd })
    try {
      let next = await iterator.next()
      while (!next.done) {
        if (run.controller.signal.aborted) break
        this.brainEvent(run, next.value)
        next = await iterator.next()
      }
      if (!run.controller.signal.aborted && next.done) {
        // 独立会话只保存最终回复，不调用聊天 finishTurn，避免任务污染人格记忆/好感度或后台标题生成。
        await this.db.appendMessage({ id: randomUUID(), sessionId: task.sessionId, role: 'assistant', content: tail(next.value.full, OUTPUT_BYTES), mode: 'text' })
      }
    } finally {
      await iterator.return(undefined as never)
    }
  }

  private brainEvent(run: ActiveRun, event: SseEvent): void {
    if (event.type === 'delta') {
      run.brainOutputBytes += Buffer.byteLength(event.delta)
      this.appendOutput(run, event.delta, 'assistant')
      if (run.brainOutputBytes > OUTPUT_BYTES * 4) this.abortRun(run, 'failed', '内置回合输出超过 1 MiB，已停止；保留最后 256 KiB')
    } else if (event.type === 'tool_confirm') {
      const task = this.tasks.get(run.taskId)!
      // 审批展示必须保留与实际执行完全相同的命令；长度限制由源头在登记确认前拒绝，不能截掉危险前缀。
      const pendingApproval = { turnId: event.turnId, toolCallId: event.toolCallId, command: String(event.args.command ?? ''), expiresAt: event.expiresAt }
      const next: AgentTask = { ...task, status: 'waiting_approval', pendingApproval, revision: task.revision + 1, updatedAt: Date.now() }
      // running → waiting_approval：持久化握手后再通知，刷新或 SSE 断开不会丢失待确认命令。
      this.store.saveTaskEvent(next, 'approval', { pendingApproval, status: next.status, revision: next.revision })
      this.tasks.set(task.id, next)
      clearTimeout(run.approvalTimer)
      run.approvalTimer = setTimeout(() => this.clearApproval(run, 'timeout'), Math.max(0, event.expiresAt - Date.now()))
    } else if (event.type === 'tool_start' || event.type === 'tool_update' || event.type === 'tool_end') {
      const task = this.tasks.get(run.taskId)!
      if (event.type === 'tool_end' && task.pendingApproval?.toolCallId === event.toolCallId) this.clearApproval(run, 'settled')
      const encoded = JSON.stringify(event)
      this.store.addEvent(task.userId, task.id, 'tool', Buffer.byteLength(encoded) > 32_768 ? { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, truncated: true } : { ...event })
    } else if (event.type === 'error') throw new Error(event.message)
  }

  private clearApproval(run: ActiveRun, reason: string): void {
    clearTimeout(run.approvalTimer)
    run.approvalTimer = undefined
    const task = this.tasks.get(run.taskId)!
    if (task.status !== 'waiting_approval' || run.controller.signal.aborted) return
    const next: AgentTask = { ...task, status: 'running', pendingApproval: null, revision: task.revision + 1, updatedAt: Date.now() }
    // 确认落定/超时 → running，由原始工具循环消费拒绝或批准结果；不重放 bash。
    this.store.saveTaskEvent(next, 'approval', { pendingApproval: null, status: next.status, reason, revision: next.revision })
    this.tasks.set(task.id, next)
  }

  private async runNative(run: ActiveRun, profile: AgentProfile, prompt: string): Promise<void> {
    const path = await executablePath(profile.command || profile.runtime)
    if (!path) throw new Error(`未找到可执行的 ${profile.name}，请在本机安装或检查路径`)
    if (run.controller.signal.aborted) return
    const args = [...profile.args]
    if (profile.runtime !== 'custom' && profile.model && !args.includes('--model') && !args.includes('-m')) {
      const index = ['codex', 'opencode', 'goose'].includes(profile.runtime) ? 1 : 0
      args.splice(index, 0, '--model', profile.model)
    }
    assertSafeArgs(args)
    const expanded = args.map((arg) => arg === '{prompt}' ? prompt : arg)
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    // 每次 run 独立进程组；不通过 shell 解释命令、参数或提示词。
    const child = spawn(path, expanded, { cwd: run.cwd, env: agentEnvironment(), detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    run.child = child
    const onAbort = (): void => { void this.terminateOwned(run) }
    run.controller.signal.addEventListener('abort', onAbort, { once: true })
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => this.appendOutput(run, stdout.write(chunk), 'stdout'))
      child.stderr.on('data', (chunk: Buffer) => this.appendOutput(run, stderr.write(chunk), 'stderr'))
      child.once('error', reject)
      child.once('exit', () => { void this.terminateOwned(run) })
      child.once('close', (code, signal) => {
        this.appendOutput(run, stdout.end(), 'stdout')
        this.appendOutput(run, stderr.end(), 'stderr')
        resolve({ code, signal })
      })
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && !run.controller.signal.aborted) reject(error)
      })
    })
    try {
      if (run.controller.signal.aborted) onAbort()
      else child.stdin.end(profile.promptMode === 'stdin' ? prompt : undefined, 'utf8')
      const { code, signal } = await result
      if (!run.controller.signal.aborted && code !== 0) throw new Error(`${profile.name} 退出失败（${signal ?? `exit ${code}`}）`)
    } finally {
      run.controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private abortRun(run: ActiveRun, status: 'cancelled' | 'interrupted' | 'failed', error: string | null): void {
    if (run.forced) return
    // 先记录终态意图再发 abort；同步触发的 close/确认回执不能覆盖取消优先级。
    run.forced = { status, error }
    clearTimeout(run.approvalTimer)
    run.controller.abort()
    void this.terminateOwned(run)
  }

  /** 仅操作本实例创建的 child/Unix 进程组；绝不按程序名或持久化 PID 杀进程。 */
  private terminateOwned(run: ActiveRun): Promise<void> {
    if (run.termination) return run.termination
    const child = run.child
    if (!child?.pid || child.pid <= 0 || child.pid === process.pid) return Promise.resolve()
    const pid = child.pid
    if (process.platform === 'win32') {
      run.termination = new Promise((resolve) => {
        const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        execFile(command, ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true, env: agentEnvironment() }, () => { resolve() })
      })
      return run.termination
    }
    const signal = (kind: NodeJS.Signals): boolean => {
      try { process.kill(-pid, kind); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.warn('[agents] 无法终止 owned 进程组：', error instanceof Error ? error.message : error)
        return false
      }
    }
    if (!signal('SIGTERM')) {
      run.termination = Promise.resolve()
    } else {
      // TERM 后仍保留槽位，宽限结束对同一 owned 组 KILL，防止忽略 TERM 的孙进程继续写工作区。
      run.termination = new Promise((resolve) => setTimeout(() => { signal('SIGKILL'); resolve() }, 500))
    }
    return run.termination
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // 就绪 → 停机：阻止新请求/队列启动；排队任务持久保留，运行任务标 interrupted。
    this.stopping = true
    this.shutdownPromise = (async () => {
      for (const run of this.active.values()) this.abortRun(run, 'interrupted', '服务关闭，执行已中断；可创建续接任务')
      await Promise.all([...this.active.values()].map((run) => run.done))
      this.store.releaseScheduler()
      MANAGERS.delete(this.store.path)
      this.initialized = false
    })()
    return this.shutdownPromise
  }
}
