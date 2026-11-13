import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type {
  AgentProfile, AgentTask, AgentTaskEvent, CollaborationDevice,
  CollaborationPairing, CollaborationStatus
} from '@pi-amadeus/shared'
import type { AgentManager } from '../agents/manager.ts'
import type { AgentStore } from '../agents/store.ts'
import type { BrainConfig } from '../config.ts'

const PAIRING_TTL = 5 * 60_000
const ONLINE_TTL = 45_000
const HEARTBEAT_MS = 15_000
const MAX_BODY = 64 * 1024
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

type DeviceRow = {
  id: string; name: string; role: 'observer' | 'controller'; user_id: string
  created_at: number; last_seen_at: number; revoked_at: number | null
}
type GatewayEnv = { Bindings: HttpBindings; Variables: { device: CollaborationDevice } }
type Pairing = { userId: string; role: 'observer' | 'controller'; expiresAt: number }
type Attempt = { count: number; expiresAt: number }

/** 共享的 JSON 边界；bodyLimit 同时覆盖分块传输，不能只相信 Content-Length。 */
export async function collaborationBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new HTTPException(415, { message: '请使用 application/json' })
  }
  const value: unknown = await request.json().catch(() => {
    throw new HTTPException(400, { message: 'JSON 格式无效' })
  })
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPException(400, { message: '请求必须是 JSON 对象' })
  }
  return value as Record<string, unknown>
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new HTTPException(400, { message: `${label} 不能为空或超过 ${max} 字符` })
  }
  return value.trim()
}

function localAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter((address) => address.family === 'IPv4' && !address.internal).map((address) => address.address)
  ))]
}

function safeProfile(profile: AgentProfile): Pick<AgentProfile, 'id' | 'name' | 'runtime' | 'enabled' | 'allowRemote'> {
  const { id, name, runtime, enabled, allowRemote } = profile
  return { id, name, runtime, enabled, allowRemote }
}

/** 与普通 brain API 完全独立的、仅由本机显式启用的 LAN 能力边界。 */
export class CollaborationManager {
  private readonly db: DatabaseSync
  private readonly agents: AgentManager
  private readonly store: AgentStore
  private readonly pairings = new Map<string, Pairing>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly streams = new Map<string, Set<() => void>>()
  private server: Server | null = null
  private port = 3003
  private closed = false
  private lifecycle: Promise<void> = Promise.resolve()

  constructor(cfg: BrainConfig, agents: AgentManager, store: AgentStore) {
    this.agents = agents
    this.store = store
    if (cfg.db.path !== ':memory:') mkdirSync(dirname(cfg.db.path), { recursive: true })
    this.db = new DatabaseSync(cfg.db.path)
    try {
      this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS collaboration_devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('observer', 'controller')),
        user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS collaboration_devices_user ON collaboration_devices(user_id);
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
    // 重启只恢复设备身份，绝不恢复监听器；必须再次由桌面端明确启用。
  }

  status(userId = ''): CollaborationStatus {
    const devices = this.db.prepare('SELECT id, name, role, user_id, created_at, last_seen_at, revoked_at FROM collaboration_devices WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as DeviceRow[]
    const addresses = localAddresses()
    return {
      enabled: this.server !== null,
      port: this.port,
      urls: this.server ? (addresses.length ? addresses : ['127.0.0.1']).map((address) => `http://${address}:${this.port}`) : [],
      devices: devices.map((row) => this.device(row)),
      transport: 'http-lan'
    }
  }

  async enable(port = this.port): Promise<CollaborationStatus> {
    return this.transition(async () => {
      if (this.closed) throw new HTTPException(503, { message: '协作服务已关闭' })
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new HTTPException(400, { message: '端口必须是 0 到 65535 的整数' })
      }
      if (this.server) {
        if (port !== this.port) throw new HTTPException(409, { message: '请先关闭协作，再更换端口' })
        return this.status()
      }
      const app = this.gateway()
      const server = createAdaptorServer({ fetch: app.fetch }) as Server
      server.requestTimeout = 15_000
      server.headersTimeout = 10_000
      server.keepAliveTimeout = 5000
      server.maxHeadersCount = 50
      server.maxConnections = 128
      await new Promise<void>((resolve, reject) => {
        const onError = (): void => reject(new HTTPException(409, { message: '无法启动协作端口，请检查端口是否被占用' }))
        server.once('error', onError)
        server.listen(port, '0.0.0.0', () => {
          server.off('error', onError)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        throw new HTTPException(503, { message: '无法读取协作监听地址' })
      }
      // 显式启用成功才从「关闭」转为「监听」；失败不遗留半启用状态。
      this.port = address.port
      this.server = server
      return this.status()
    })
  }

  async disable(): Promise<void> {
    await this.transition(async () => {
      const server = this.server
      // 先关闭授权入口，再断流；停用期间不能使用旧配对码继续加入。
      this.server = null
      this.pairings.clear()
      for (const closers of this.streams.values()) for (const close of [...closers]) close()
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    })
  }

  pairing(userId: string, role: 'observer' | 'controller'): CollaborationPairing {
    if (!this.server) throw new HTTPException(409, { message: '请先在桌面端启用协作' })
    userId = requiredText(userId, 'userId', 128)
    if (role !== 'observer' && role !== 'controller') throw new HTTPException(400, { message: '设备角色无效' })
    const now = Date.now()
    for (const [key, pairing] of this.pairings) if (pairing.expiresAt <= now) this.pairings.delete(key)
    if (this.pairings.size >= 128) throw new HTTPException(429, { message: '未使用的配对码过多，请稍后重试' })
    const code = randomBytes(24).toString('base64url')
    const expiresAt = now + PAIRING_TTL
    // 配对授权仅在本机创建；内存只保存摘要，成功交换后立即销毁。
    this.pairings.set(hash(code), { userId, role, expiresAt })
    return { code, expiresAt, role }
  }

  revoke(id: string): void {
    this.db.prepare('UPDATE collaboration_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id)
    // 先持久化撤销，再立即丢弃此设备所有流的队列；不能等下次心跳才生效。
    for (const close of [...(this.streams.get(id) ?? [])]) close()
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    // 退出先拒绝新的 enable，再串行等待停用完成，避免关库后仍有监听器。
    this.closed = true
    await this.disable()
    this.db.close()
  }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation)
    this.lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  private device(row: DeviceRow): CollaborationDevice {
    return {
      id: row.id, name: row.name, role: row.role, userId: row.user_id,
      createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at,
      online: this.server !== null && row.revoked_at === null && Date.now() - row.last_seen_at < ONLINE_TTL
    }
  }

  private active(id: string): boolean {
    return this.server !== null && Boolean(this.db.prepare('SELECT 1 FROM collaboration_devices WHERE id = ? AND revoked_at IS NULL').get(id))
  }

  private touch(id: string): void {
    this.db.prepare('UPDATE collaboration_devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id)
  }

  private assertController(device: CollaborationDevice): void {
    if (!this.active(device.id)) throw new HTTPException(401, { message: '此设备的授权已失效' })
    if (device.role !== 'controller') throw new HTTPException(403, { message: '观察者只能查看，不能操作任务' })
  }

  private assertRemoteProfile(id: string): void {
    const profile = this.store.getProfile(id)
    if (!profile || !profile.enabled || !profile.allowRemote) {
      throw new HTTPException(403, { message: '此 Agent 未在桌面端开启远程执行权限' })
    }
  }

  private task(id: string, userId: string): AgentTask {
    try {
      return this.agents.getTask(id, userId)
    } catch {
      throw new HTTPException(404, { message: '任务不存在' })
    }
  }

  private checkPairingRate(ip: string): void {
    const now = Date.now()
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(key)
    const local = this.attempts.get(ip)
    const global = this.attempts.get('*')
    if ((local?.count ?? 0) >= 10 || (global?.count ?? 0) >= 100 || this.attempts.size >= 1024) {
      throw new HTTPException(429, { message: '配对失败次数过多，请 5 分钟后重试' })
    }
  }

  private badPairing(ip: string): never {
    const now = Date.now()
    for (const key of [ip, '*']) {
      const attempt = this.attempts.get(key) ?? { count: 0, expiresAt: now + PAIRING_TTL }
      attempt.count += 1
      this.attempts.set(key, attempt)
    }
    throw new HTTPException(401, { message: '配对码无效、已使用或已过期' })
  }

  private gateway(): Hono<GatewayEnv> {
    const html = readFileSync(new URL('./client.html', import.meta.url), 'utf8')
    const inlineHashes = (tag: string): string => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g'))]
      .map((match) => `'sha256-${createHash('sha256').update(match[1] ?? '').digest('base64')}'`).join(' ')
    const app = new Hono<GatewayEnv>()
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('X-Frame-Options', 'DENY')
      c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      c.header('Content-Security-Policy', `default-src 'none'; script-src ${inlineHashes('script')}; style-src ${inlineHashes('style')}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
      const url = new URL(c.req.url)
      // 只接受本机真实地址，防 DNS rebinding；浏览器只能同源，绝不添加 wildcard CORS。
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', ...localAddresses()].includes(url.hostname) || Number(url.port || 80) !== this.port) {
        return c.json({ error: '协作地址无效，请使用桌面端显示的地址' }, 403)
      }
      const origin = c.req.header('Origin')
      if (origin && origin !== url.origin) return c.json({ error: '不允许跨源访问' }, 403)
      if (!this.server) return c.json({ error: '协作未启用' }, 503)
      await next()
    })
    app.use('*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: '请求体不得超过 64 KiB' }, 413) }))
    app.onError((error, c) => {
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
      // 远程不返回执行命令、路径、堆栈或配置；原始详情留在本机控制台。
      console.error('[collaboration] 请求失败', error)
      return c.json({ error: '任务操作失败，请在桌面端查看详情' }, 400)
    })
    app.get('/', (c) => c.html(html))
    app.post('/pair', async (c) => {
      const ip = c.env.incoming.socket.remoteAddress ?? 'unknown'
      this.checkPairingRate(ip)
      let body: Record<string, unknown>
      try { body = await collaborationBody(c.req.raw) } catch { return this.badPairing(ip) }
      const name = requiredText(body.name, '设备名称', 80)
      const code = typeof body.code === 'string' && body.code.length <= 128 ? body.code.trim() : ''
      const key = hash(code)
      const pairing = this.pairings.get(key)
      if (!pairing || pairing.expiresAt <= Date.now()) return this.badPairing(ip)
      const token = randomBytes(32).toString('base64url')
      const row: DeviceRow = { id: randomUUID(), name, role: pairing.role, user_id: pairing.userId, created_at: Date.now(), last_seen_at: Date.now(), revoked_at: null }
      this.db.prepare('INSERT INTO collaboration_devices (id, name, role, user_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.name, row.role, row.user_id, hash(token), row.created_at, row.last_seen_at)
      // 写入成功后消费一次性授权；明文令牌只在这一次响应中出现。
      this.pairings.delete(key)
      return c.json({ device: this.device(row), token }, 201)
    })
    app.use('/api/*', async (c, next) => {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header('Authorization') ?? '')?.[1]
      const row = token ? this.db.prepare('SELECT id, name, role, user_id, created_at, last_seen_at, revoked_at FROM collaboration_devices WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token)) as DeviceRow | undefined : undefined
      if (!row) return c.json({ error: '设备未配对或已被撤销，请在桌面端重新配对' }, 401)
      this.touch(row.id)
      c.set('device', this.device({ ...row, last_seen_at: Date.now() }))
      await next()
      if (!this.active(row.id)) return c.json({ error: '此设备的授权已失效' }, 401)
    })
    app.get('/api/device', (c) => c.json({ device: c.get('device') }))
    app.get('/api/agents', async (c) => {
      const overview = await this.agents.overview(c.get('device').userId)
      return c.json({ profiles: overview.profiles.map(safeProfile), tasks: overview.tasks, maxConcurrent: overview.maxConcurrent })
    })
    app.get('/api/agents/tasks/:id', (c) => c.json(this.task(c.req.param('id'), c.get('device').userId)))
    app.post('/api/agents/tasks', async (c) => {
      const device = c.get('device')
      this.assertController(device)
      const body = await collaborationBody(c.req.raw)
      this.assertController(device)
      if (body.userId !== undefined && body.userId !== device.userId) throw new HTTPException(403, { message: '不能操作其他用户的任务' })
      const agentId = requiredText(body.agentId, 'Agent', 128)
      this.assertRemoteProfile(agentId)
      const task = await this.agents.createTask({
        userId: device.userId, agentId,
        title: requiredText(body.title, '标题', 160),
        prompt: requiredText(body.prompt, '任务内容', 32_000),
        cwd: typeof body.cwd === 'string' && body.cwd.trim() ? requiredText(body.cwd, '工作目录', 4096) : '',
        requestId: requiredText(body.requestId, 'requestId', 128)
      }, true)
      return c.json(task, 201)
    })
    app.post('/api/agents/tasks/:id/stop', async (c) => {
      const device = c.get('device')
      this.assertController(device)
      const task = this.task(c.req.param('id'), device.userId)
      return c.json(await this.agents.stop(task.id, device.userId))
    })
    app.post('/api/agents/tasks/:id/resume', async (c) => {
      const device = c.get('device')
      this.assertController(device)
      const task = this.task(c.req.param('id'), device.userId)
      const body = await collaborationBody(c.req.raw)
      this.assertController(device)
      const agentId = body.agentId === undefined ? task.agentId : requiredText(body.agentId, 'Agent', 128)
      this.assertRemoteProfile(agentId)
      return c.json(await this.agents.resume(task.id, device.userId,
        requiredText(body.prompt, '继续指令', 32_000), requiredText(body.requestId, 'requestId', 128), agentId, true))
    })
    app.post('/api/agents/tasks/:id/approve', async (c) => {
      const device = c.get('device')
      this.assertController(device)
      const body = await collaborationBody(c.req.raw)
      this.assertController(device)
      if (typeof body.approved !== 'boolean') throw new HTTPException(400, { message: 'approved 必须是布尔值' })
      const turnId = requiredText(body.turnId, 'turnId', 256)
      const toolCallId = requiredText(body.toolCallId, 'toolCallId', 256)
      const task = this.task(c.req.param('id'), device.userId)
      const pending = task.pendingApproval
      if (!pending || pending.turnId !== turnId || pending.toolCallId !== toolCallId) {
        throw new HTTPException(409, { message: '这条命令确认已过期，请刷新任务后再试' })
      }
      return c.json(await this.agents.approve(task.id, device.userId, body.approved, { turnId, toolCallId }))
    })
    app.get('/api/agents/events', (c) => {
      const raw = c.req.header('Last-Event-ID') ?? c.req.query('after') ?? '0'
      const after = Number(raw)
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after)) throw new HTTPException(400, { message: '事件游标无效' })
      return this.events(c.get('device'), after, c.req.raw.signal, c.env.outgoing)
    })
    return app
  }

  private events(device: CollaborationDevice, after: number, signal: AbortSignal, outgoing: HttpBindings['outgoing']): Response {
    const closers = this.streams.get(device.id) ?? new Set<() => void>()
    if (closers.size >= 3 || [...this.streams.values()].reduce((sum, set) => sum + set.size, 0) >= 64) {
      throw new HTTPException(429, { message: '实时连接过多，请关闭其他标签页' })
    }
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array>
    let cursor = after
    let batch: AgentTaskEvent[] = []
    let index = 0
    let dirty = true
    let ended = false
    let unsubscribe = (): void => {}
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const cleanup = (): void => {
      if (ended) return
      // 断网、撤销或停用都进入终态，并同时移除订阅、定时器与 socket 监听。
      ended = true
      unsubscribe()
      clearInterval(heartbeat)
      signal.removeEventListener('abort', close)
      outgoing.off('close', close)
      closers.delete(close)
      if (!closers.size) this.streams.delete(device.id)
    }
    const close = (): void => {
      if (ended) return
      cleanup()
      // 先销毁此响应的 socket，撤销后不再 drain 缓存；正常断流不向日志抛伪故障。
      outgoing.destroy()
      controller?.close()
    }
    const pump = (): void => {
      if (ended) return
      try {
        if (!this.active(device.id)) return close()
        while ((controller.desiredSize ?? 0) > 0) {
          if (index >= batch.length) {
            if (!dirty) return
            // 订阅只是唤醒信号，事件始终从持久库续读；慢客户端不会累积无限 live 队列。
            batch = this.store.listEvents(device.userId, cursor)
            index = 0
            dirty = batch.length > 0
            if (!batch.length) return
          }
          const event = batch[index++]!
          if (event.seq <= cursor) continue
          controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: task\ndata: ${JSON.stringify(event)}\n\n`))
          cursor = event.seq
        }
      } catch {
        close()
      }
    }
    const body = new ReadableStream<Uint8Array>({
      start: (target) => {
        controller = target
        closers.add(close)
        this.streams.set(device.id, closers)
        signal.addEventListener('abort', close, { once: true })
        outgoing.once('close', close)
        // 先订阅再重放，避免 snapshot/replay 与 live 交接之间丢事件。
        unsubscribe = this.store.subscribe((userId, event) => {
          if (userId !== device.userId || event.seq <= cursor) return
          dirty = true
          pump()
        })
        if (signal.aborted || !this.active(device.id)) return close()
        controller.enqueue(encoder.encode(': connected\n\n'))
        heartbeat = setInterval(() => {
          if (!this.active(device.id)) return close()
          this.touch(device.id)
          if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`))
        }, HEARTBEAT_MS)
        heartbeat.unref()
        pump()
      },
      pull: pump,
      cancel: cleanup
    }, { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength })
    return new Response(body, { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    } })
  }
}
