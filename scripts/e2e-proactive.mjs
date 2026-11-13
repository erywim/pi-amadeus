/**
 * 后台/桌宠主动问候 E2E。
 *
 * 覆盖的操作序列：
 *  A. 大脑契约（本脚本自起一个独立 brain：PORT/DB_PATH 都指向临时资源，不碰真实会话库）
 *     - 参数校验：缺字段 / 非法 base64 / 超限帧 → 400
 *     - 纯文本模型 → 422 no_vision，且不留会话、不落消息
 *     - 视觉模型 → 200：问候落库为「唯一一条助手消息」，截图不进库，
 *       情绪行【情】被解析出来并从正文剔除；会话不存在时新建
 *     - 指定别人的 sessionId → 404；同一会话再来一次 → 历史里能看到上一条问候
 *  B. 桌面端调度与投递（CDP 驱动真实桌面端 dev）
 *     - 前台（eligible=false）→ 不发请求，nextDueAt 清空
 *     - busy（正在对话）→ 不发请求，顺延 1 分钟
 *     - 开关关闭 → 不发请求
 *     - 后台 + 到点触发 → 大脑收到一次带 image_url 的请求；问候推进渲染层
 *       （dialogText / proactiveSeq）、弹系统通知（计数值 +1）、
 *       nextDueAt 落在 [10, 15] 分钟
 *     - 大脑不可达 → lastOutcome=failed、lastError 非空，不崩
 *     - 真实截屏路径：仅当系统已授予屏幕录制权限时跑；否则明确输出 not run
 *
 * 前置：桌面端 dev（CDP 9222，可用 CDP_HTTP 覆盖）+ 真实 brain（默认 3002）已启动，
 * 且桌面端已登录（userId 非空）。真实 brain 只用于让桌面端完成初始化；
 * 主动问候的生成走脚本自起的 hermetic brain + 本地 stub LLM，不消耗真实模型额度。
 *
 * 用法：node scripts/e2e-proactive.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const REAL_BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'

const STUB_REPLY = '【情】teasing\n哼，又盯着屏幕这么久，肩膀不酸吗，笨蛋。'
const STUB_TEXT = STUB_REPLY.split('\n')[1]
/** 2x2 红色 JPEG（base64）：大脑只校验 base64/大小，stub 只断言它被当 image_url 转发 */
const FRAME_B64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------- CDP ----------

async function pages() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  return (await res.json()).filter((t) => t.type === 'page')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        call(method, params = {}) {
          return new Promise((res, rej) => {
            const callId = ++id
            pending.set(callId, { res, rej })
            ws.send(JSON.stringify({ id: callId, method, params }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${e.message ?? 'unknown'}`))
    ws.onclose = () => {
      for (const { rej } of pending.values()) rej(new Error('CDP 连接已关闭'))
      pending.clear()
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    }
  })
}

async function evalJs(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error(`页面脚本异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result.value
}

async function waitFor(cdp, expression, timeoutMs = 15000, label = expression) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(cdp, expression).catch(() => null)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(150)
  }
}

const proactiveCommand = (cdp, command) =>
  evalJs(cdp, `window.api.debug.proactive(${JSON.stringify(command)})`)

/** 等某个页面目标出现/消失（桌宠窗口是独立的渲染层） */
async function waitForPage(pred, present, timeoutMs = 15000) {
  const start = Date.now()
  for (;;) {
    const hit = (await pages()).find((p) => pred(p.url))
    if (present ? hit : !hit) return hit ?? null
    if (Date.now() - start > timeoutMs) throw new Error(`等待页面${present ? '出现' : '消失'}超时`)
    await sleep(150)
  }
}

// ---------- 本地 stub LLM（OpenAI 兼容 SSE） ----------

/** 收到的 /chat/completions 请求体（按时间顺序） */
const stubRequests = []

function startStubLlm() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        stubRequests.push(JSON.parse(body))
      } catch {
        stubRequests.push({ parseError: true })
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const base = { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model: 'gpt-4o-mini' }
      const created = Math.floor(Date.now() / 1000)
      res.write(`data: ${JSON.stringify({ ...base, created, choices: [{ index: 0, delta: { role: 'assistant', content: STUB_REPLY }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, created, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, created, choices: [], usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }))
  })
}

// ---------- hermetic brain ----------

async function freePort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}

function startBrain({ port, dbPath, llmBaseUrl, skillsDir }) {
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: join(ROOT, 'services/brain'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      LLM_BASE_URL: llmBaseUrl,
      LLM_API_KEY: 'e2e-stub-key',
      AI_MODEL: 'gpt-4o-mini',
      FEISHU_ENABLED: 'false',
      SKILLS_DIR: skillsDir,
      // 别让 .env 里的真实代理/密钥混进来：stub 就在本机
      FISH_AUDIO_PROXY: '',
      WHISPER_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (chunk) => {
    log += chunk
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
  })
  return { child, log: () => log }
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const start = Date.now()
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`hermetic brain 未在 ${timeoutMs}ms 内就绪`)
    await sleep(200)
  }
}

// ---------- HTTP 小工具 ----------

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text }
}

async function resolveUser(baseUrl, username) {
  const { status, json } = await postJson(`${baseUrl}/api/users/resolve`, { username })
  if (status !== 200 || !json?.userId) throw new Error(`创建测试用户失败：HTTP ${status}`)
  return json.userId
}

async function messagesOf(baseUrl, sessionId) {
  const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`)
  if (!res.ok) throw new Error(`读取会话消息失败：HTTP ${res.status}`)
  return (await res.json()).messages
}

/**
 * hermetic 库里补一行真实桌面用户的 users 记录：sessions.user_id 有外键。
 * 只写临时库（DB_PATH 指向 mkdtemp 目录），不碰真实数据；brain 与本进程并发写，
 * SQLITE_BUSY 时短暂重试。
 */
async function ensureUserRow(dbPath, userId, username) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('INSERT OR IGNORE INTO users (id, username, created_at) VALUES (?, ?, ?)').run(
        userId,
        username,
        Date.now()
      )
      return
    } catch (error) {
      const message = String(error)
      if (!message.includes('locked') && !message.includes('busy')) throw error
      await sleep(100)
    } finally {
      db.close()
    }
  }
  throw new Error('向 hermetic 库补用户记录超时（SQLITE_BUSY）')
}

// ---------- 主流程 ----------

let stub
let brain
let tmpDir
let cdp
/** 收尾（信号兜底与正常结束共用，只跑一次） */
let cleanupPromise = null

async function cleanupOnce() {
  cleanupPromise ??= (async () => {
    if (cdp) {
      // 还原桌面端状态：身份/会话临时改过（见 B 段），调试覆盖全部清空
      await evalJs(
        cdp,
        `(() => {
          const saved = window.__proactiveE2eSaved
          if (saved) {
            window.__amadeus.sessionStore.setState({ userId: saved.userId, activeSessionId: saved.activeSessionId })
            window.__amadeus.uiStore.getState().setDialogText(saved.dialogText)
            window.__amadeus.settingsStore.getState().setProactiveEnabled(saved.proactiveEnabled)
            if (saved.path && window.location.pathname !== saved.path) {
              window.history.pushState({}, '', saved.path)
              window.dispatchEvent(new PopStateEvent('popstate'))
            }
          }
          const api = window.api?.debug?.proactive
          if (api) {
            void api({ op: 'frame', value: null })
            void api({ op: 'eligible', value: null })
            void api({ op: 'brain', value: null })
          }
          window.api?.proactive?.setConfig({ enabled: saved ? saved.proactiveEnabled : true, busy: false })
          return true
        })()`
      ).catch(() => {})
      cdp.close()
      cdp = null
    }
    if (brain) {
      brain.child.kill('SIGTERM')
      brain = null
    }
    if (stub) {
      await new Promise((r) => stub.server.close(r))
      stub = null
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      tmpDir = null
    }
  })()
  return cleanupPromise
}

let signalExitCode = null
function onSignal(code) {
  if (signalExitCode !== null) process.exit(code)
  signalExitCode = code
  void cleanupOnce().then(() => process.exit(code))
}
process.on('SIGINT', () => onSignal(130))
process.on('SIGTERM', () => onSignal(143))

try {
  // ---------- 准备 hermetic 环境 ----------
  stub = await startStubLlm()
  const brainPort = await freePort()
  const BRAIN = `http://127.0.0.1:${brainPort}`
  tmpDir = await mkdtemp(join(tmpdir(), 'pi-amadeus-proactive-e2e-'))
  const dbPath = join(tmpDir, 'e2e.db')
  brain = startBrain({
    port: brainPort,
    dbPath,
    llmBaseUrl: `http://127.0.0.1:${stub.port}/v1`,
    skillsDir: join(tmpDir, 'skills')
  })
  await waitForHealth(BRAIN)
  console.log(`[e2e] hermetic brain ${BRAIN}（临时库，stub LLM ${stub.port}）`)

  console.log('\n=== A. 大脑契约 ===')
  const textUser = await resolveUser(BRAIN, 'proactive-text-e2e-user')
  const visionUser = await resolveUser(BRAIN, 'proactive-vision-e2e-user')
  const unknownUser = '00000000-0000-4000-8000-000000000404'

  const unknownBefore = stubRequests.length
  const unknown = await postJson(`${BRAIN}/api/proactive`, { userId: unknownUser, frame: FRAME_B64 })
  report(
    '未知用户在模型调用前 → 404',
    unknown.status === 404 && unknown.json?.code === 'user_not_found' && stubRequests.length === unknownBefore,
    `status=${unknown.status} code=${unknown.json?.code}`
  )

  const missing = await postJson(`${BRAIN}/api/proactive`, { userId: visionUser })
  report('缺 frame → 400', missing.status === 400, `status=${missing.status}`)

  const badB64 = await postJson(`${BRAIN}/api/proactive`, { userId: visionUser, frame: '%%%not-base64%%%' })
  report('非法 base64 → 400', badB64.status === 400, `status=${badB64.status}`)

  const oversized = await postJson(`${BRAIN}/api/proactive`, {
    userId: visionUser,
    frame: 'A'.repeat(6_000_000)
  })
  report('超限帧 → 400', oversized.status === 400, `status=${oversized.status}`)

  // 纯文本模型：在调用 LLM 前按能力拒绝，且不留下会话
  await fetch(`${BRAIN}/api/config/${textUser}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { provider: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'deepseek-v4-pro' } }
    })
  })
  const noVision = await postJson(`${BRAIN}/api/proactive`, { userId: textUser, frame: FRAME_B64 })
  report(
    '纯文本模型 → 422 no_vision',
    noVision.status === 422 && noVision.json?.code === 'no_vision',
    `status=${noVision.status} code=${noVision.json?.code}`
  )
  const textSessions = await fetch(`${BRAIN}/api/sessions?userId=${encodeURIComponent(textUser)}`).then((r) => r.json())
  report('被拒的问候不建会话、不落消息', textSessions.sessions.length === 0, `sessions=${textSessions.sessions.length}`)

  // 视觉模型：无 sessionId → 新建会话，问候落库
  const beforeRequests = stubRequests.length
  const first = await postJson(`${BRAIN}/api/proactive`, { userId: visionUser, frame: FRAME_B64 })
  const greeting = first.json ?? {}
  report(
    '视觉模型 → 200 且解析出情绪与正文',
    first.status === 200 && greeting.ok === true && greeting.text === STUB_TEXT && greeting.emotion === 'teasing',
    `status=${first.status} text=${String(greeting.text).slice(0, 24)} emotion=${greeting.emotion}`
  )
  report('无会话时自动新建', typeof greeting.sessionId === 'string' && greeting.sessionId.length > 0, greeting.sessionId ?? '')
  report('响应带 messageId / createdAt', typeof greeting.messageId === 'string' && typeof greeting.createdAt === 'number')

  const newRequests = stubRequests.slice(beforeRequests)
  const reqBody = newRequests[0] ?? {}
  const lastUser = [...(reqBody.messages ?? [])].reverse().find((m) => m.role === 'user')
  const parts = Array.isArray(lastUser?.content) ? lastUser.content : []
  const imageParts = parts.filter((p) => p.type === 'image_url')
  report(
    'stub 收到的请求带 image_url（截图真的进了 LLM）',
    newRequests.length === 1 &&
      imageParts.length === 1 &&
      String(imageParts[0].image_url?.url).startsWith('data:image/jpeg;base64,'),
    `requests=${newRequests.length} images=${imageParts.length}`
  )

  const stored = await messagesOf(BRAIN, greeting.sessionId)
  report(
    '问候落库为唯一一条助手消息（截图/系统提示不落库）',
    stored.length === 1 &&
      stored[0].role === 'assistant' &&
      stored[0].content === STUB_TEXT &&
      !stored.some((m) => m.role === 'user'),
    `messages=${stored.length} roles=${stored.map((m) => m.role).join(',')}`
  )

  // 同一会话再来一次：历史里能看到上一条问候
  const second = await postJson(`${BRAIN}/api/proactive`, {
    userId: visionUser,
    sessionId: greeting.sessionId,
    frame: FRAME_B64
  })
  report('指定已存在会话 → 200', second.status === 200, `status=${second.status}`)
  const secondReq = stubRequests.at(-1) ?? {}
  const historyHasGreeting = (secondReq.messages ?? []).some(
    (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(STUB_TEXT)
  )
  report('上一轮问候进入历史上下文', historyHasGreeting)
  const afterSecond = await messagesOf(BRAIN, greeting.sessionId)
  report(
    '第二个问候同样只追加助手消息',
    afterSecond.length === 2 && afterSecond.every((m) => m.role === 'assistant'),
    `messages=${afterSecond.length}`
  )

  const foreign = await postJson(`${BRAIN}/api/proactive`, {
    userId: textUser,
    sessionId: greeting.sessionId,
    frame: FRAME_B64
  })
  report('拿别人的 sessionId → 404', foreign.status === 404, `status=${foreign.status}`)

  // ---------- B. 桌面端调度与投递 ----------
  console.log('\n=== B. 桌面端调度与投递 ===')
  const realBrainOk = await fetch(`${REAL_BRAIN}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false)
  report('前置：真实 brain 可达（桌面端初始化用）', realBrainOk, REAL_BRAIN)

  const page = (await pages()).find((p) => !p.url.includes('window=pet'))
  if (!realBrainOk || !page) {
    report('桌面端页面可用', false, page ? '' : `${CDP_HTTP} 上没有非桌宠页面`)
    throw new Error('桌面端前置不满足，B 段未运行')
  }
  cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')
  const userId = await waitFor(cdp, `window.__amadeus?.sessionStore.getState().userId`, 20000, 'userId')
  report('前置：桌面端已登录', typeof userId === 'string' && userId.length > 0, String(userId))

  // 保存并临时改桌面端状态：/settings 页没有自动选会话的副作用
  await evalJs(
    cdp,
    `(() => {
      const s = window.__amadeus.sessionStore.getState()
      window.__proactiveE2eSaved = {
        userId: s.userId,
        activeSessionId: s.activeSessionId,
        dialogText: window.__amadeus.uiStore.getState().dialogText,
        proactiveEnabled: window.__amadeus.settingsStore.getState().proactiveEnabled,
        path: window.location.pathname
      }
      return true
    })()`
  )
  await evalJs(
    cdp,
    `(() => {
      window.history.pushState({}, '', '/settings')
      window.dispatchEvent(new PopStateEvent('popstate'))
      return true
    })()`
  )
  // 等设置页真的挂载（左侧分类导航的 aria-current）——陪伴页还在时会自动选最新会话，
  // 早一步清空 activeSessionId 会被它的 effect 抢回去
  await waitFor(
    cdp,
    `window.location.pathname.includes('settings') && !!document.querySelector('nav button[aria-current="page"]')`,
    5000,
    '/settings 挂载'
  )
  await evalJs(cdp, `window.__amadeus.sessionStore.setState({ activeSessionId: null }); true`)
  // 桌面端上报是异步 IPC：等到主进程确认"没有会话"，再触发，避免用上一轮的会话 id
  await waitFor(
    cdp,
    `window.api.debug.proactive({ op: 'state' }).then((s) => s.hasSession === false)`,
    5000,
    '主进程收到 activeSessionId=null'
  )
  await evalJs(
    cdp,
    `window.__amadeus.settingsStore.getState().setProactiveEnabled(true); true`
  )

  // 桌面端用的是真实 brain 里的 userId：在临时库里补一行用户（sessions.user_id 有外键）
  await ensureUserRow(dbPath, userId, `proactive-desktop-${userId}`)

  // 真实判定（还没加任何 debug 覆盖）：eligible 必须等于"文档没有焦点"
  const beforeEach = await proactiveCommand(cdp, { op: 'state' })
  const documentFocused = await evalJs(cdp, `document.hasFocus()`)
  report(
    '后台判定与窗口焦点一致（真实判定）',
    beforeEach.eligible === !documentFocused,
    `eligible=${beforeEach.eligible} hasFocus=${documentFocused}`
  )

  const injected = await proactiveCommand(cdp, { op: 'frame', value: FRAME_B64 })
  await proactiveCommand(cdp, { op: 'eligible', value: true })
  await proactiveCommand(cdp, { op: 'brain', value: BRAIN })
  report('注入 e2e 帧 / 后台 / hermetic brain', injected.frameInjected === true, `brain=${BRAIN}`)

  const beforeState = await proactiveCommand(cdp, { op: 'state' })
  const seqBefore = await evalJs(cdp, `window.__amadeus.companionStore.getState().proactiveSeq`)
  const stubBeforeDelivered = stubRequests.length

  const delivered = await proactiveCommand(cdp, { op: 'trigger' })
  report('后台触发 → delivered', delivered.outcome === 'delivered', `outcome=${delivered.outcome} err=${delivered.lastError}`)
  report(
    '问候投递计数 +1',
    delivered.deliveredCount === beforeState.deliveredCount + 1,
    `${beforeState.deliveredCount} → ${delivered.deliveredCount}`
  )
  report(
    '系统通知发起一次',
    delivered.notificationSupported
      ? delivered.notifiedCount === beforeState.notifiedCount + 1
      : delivered.notifiedCount === beforeState.notifiedCount,
    delivered.notificationSupported ? `${beforeState.notifiedCount} → ${delivered.notifiedCount}` : 'platform unsupported (not run)'
  )
  report('本次生成走了一次 stub LLM', stubRequests.length === stubBeforeDelivered + 1)

  const dueDelta = delivered.nextDueAt - delivered.lastAt
  report(
    '下次到期落在 10~15 分钟',
    dueDelta >= 10 * 60_000 && dueDelta <= 15 * 60_000,
    `${Math.round(dueDelta / 1000)}s`
  )

  await waitFor(
    cdp,
    `window.__amadeus.uiStore.getState().dialogText === ${JSON.stringify(STUB_TEXT)}`,
    5000,
    '渲染层收到问候文本'
  )
  report('渲染层对话框收到问候', true)
  const seqAfter = await evalJs(cdp, `window.__amadeus.companionStore.getState().proactiveSeq`)
  report('主动问候被当成新的一轮（proactiveSeq +1）', seqAfter === seqBefore + 1, `${seqBefore} → ${seqAfter}`)
  const emotion = await evalJs(cdp, `window.__amadeus.live2dStore.getState().emotion`)
  report('问候携带的情绪已驱动表情', emotion === 'teasing', String(emotion))

  const userSessions = await fetch(`${BRAIN}/api/sessions?userId=${encodeURIComponent(userId)}`).then((r) => r.json())
  const greetingSession = userSessions.sessions.find((s) => s.messageCount === 1)
  const persisted = greetingSession ? await messagesOf(BRAIN, greetingSession.id) : []
  report(
    '问候在服务端落库（桌面端 userId 名下）',
    !!greetingSession && persisted.length === 1 && persisted[0].content === STUB_TEXT,
    greetingSession ? `session=${greetingSession.id}` : `sessions=${userSessions.sessions.length}`
  )

  // 前台：清掉到期时刻，不发请求
  await proactiveCommand(cdp, { op: 'eligible', value: false })
  const stubBeforeForeground = stubRequests.length
  const foreground = await proactiveCommand(cdp, { op: 'trigger' })
  report(
    '前台不打扰：outcome=foreground 且无新请求',
    foreground.outcome === 'foreground' &&
      foreground.nextDueAt === null &&
      stubRequests.length === stubBeforeForeground,
    `outcome=${foreground.outcome} nextDueAt=${foreground.nextDueAt}`
  )

  // busy：正在对话时顺延，不发请求
  await proactiveCommand(cdp, { op: 'eligible', value: true })
  await evalJs(cdp, `window.api.proactive.setConfig({ busy: true }); true`)
  const stubBeforeBusy = stubRequests.length
  const busy = await proactiveCommand(cdp, { op: 'trigger' })
  report(
    '对话进行中不打断：outcome=busy 且无新请求',
    busy.outcome === 'busy' && stubRequests.length === stubBeforeBusy,
    `outcome=${busy.outcome}`
  )
  await evalJs(cdp, `window.api.proactive.setConfig({ busy: false }); true`)

  // 开关关闭：什么都不做
  await evalJs(cdp, `window.api.proactive.setConfig({ enabled: false }); true`)
  const stubBeforeDisabled = stubRequests.length
  const disabled = await proactiveCommand(cdp, { op: 'trigger' })
  report(
    '开关关闭：outcome=disabled 且无新请求',
    disabled.outcome === 'disabled' && stubRequests.length === stubBeforeDisabled,
    `outcome=${disabled.outcome}`
  )
  await evalJs(
    cdp,
    `window.api.proactive.setConfig({ enabled: window.__amadeus.settingsStore.getState().proactiveEnabled }); true`
  )

  // 大脑不可达：失败要被记录，不能崩
  const closedPort = await freePort()
  await proactiveCommand(cdp, { op: 'brain', value: `http://127.0.0.1:${closedPort}` })
  const failed = await proactiveCommand(cdp, { op: 'trigger' })
  report(
    '大脑不可达 → failed 且记录原因',
    failed.outcome === 'failed' && failed.lastError.length > 0 && failed.deliveredCount === delivered.deliveredCount,
    failed.lastError.slice(0, 60)
  )
  await proactiveCommand(cdp, { op: 'brain', value: BRAIN })

  // 真实截屏：有权限才跑，没权限明确 not run
  await proactiveCommand(cdp, { op: 'frame', value: null })
  if (failed.screenPermission === 'granted') {
    const realCapture = await proactiveCommand(cdp, { op: 'trigger' })
    report(
      '真实桌面截屏 → 生成并投递',
      realCapture.outcome === 'delivered',
      `outcome=${realCapture.outcome} err=${realCapture.lastError}`
    )
  } else {
    // 没有权限时不能静默重试：跳过一次并留下可读原因，等用户去系统设置授权
    const denied = await proactiveCommand(cdp, { op: 'trigger' })
    report(
      '未授权截屏时跳过并记录原因',
      denied.outcome === 'failed' && denied.lastError.includes('截屏不可用'),
      `outcome=${denied.outcome} err=${denied.lastError}`
    )
    report('真实桌面截屏（跳过：未授予屏幕录制权限）', true, `not run — permission=${failed.screenPermission}`)
  }

  // ---------- C. 桌宠模式：真实判定，不靠 debug 覆盖 ----------
  console.log('\n=== C. 桌宠模式判定 ===')
  await proactiveCommand(cdp, { op: 'eligible', value: null })
  await evalJs(cdp, `window.api.setMode('pet'); true`)
  const petPage = await waitForPage((url) => url.includes('window=pet'), true)
  const petCdp = await connect(petPage.webSocketDebuggerUrl)
  try {
    await petCdp.call('Runtime.enable')
    await waitFor(petCdp, `window.api?.debug?.proactive`, 15000, '桌宠页 debug 接口')
    const petState = await proactiveCommand(petCdp, { op: 'state' })
    report(
      '桌宠模式本身满足触发条件（无 debug 覆盖）',
      petState.mode === 'pet' && petState.eligible === true,
      `mode=${petState.mode} eligible=${petState.eligible}`
    )
  } finally {
    await evalJs(petCdp, `window.api.setMode('window'); true`).catch(() => {})
    petCdp.close()
  }
  await waitForPage((url) => url.includes('window=pet'), false, 15000)
  report('退出桌宠回到窗口模式', !(await pages()).some((p) => p.url.includes('window=pet')))

  const failedCount = results.filter((r) => !r.ok).length
  console.log(`\n=== 汇总: ${results.length - failedCount}/${results.length} 通过 ===`)
  if (failedCount > 0) process.exitCode = 1
} catch (error) {
  console.error(`\n[e2e] 中止：${error instanceof Error ? error.message : error}`)
  if (brain) console.error(`[brain 日志尾部]\n${brain.log().slice(-3000)}`)
  process.exitCode = 1
} finally {
  await cleanupOnce()
}
