/**
 * E2E 用的 brain 进程夹具：临时 SQLite + 随机端口 + 独立子进程。
 *
 * 为什么不用已经在跑的 brain：压缩/工作流的断言需要干净的库和确定的配置，
 * 写进用户真实数据目录会污染会话（AGENTS.md 明确禁止）。
 *
 * 不是 e2e-*.mjs，不会被 `npm run e2e` 收编。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BRAIN_DIR = join(REPO_ROOT, 'services', 'brain')

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export async function startTestBrain(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pi-amadeus-e2e-'))
  const dbPath = join(dataDir, 'test.db')
  // 启动前预置数据库（模拟老库 / 造历史数据），在 schema 初始化之前执行
  if (typeof options.setup === 'function') await options.setup(dbPath)
  const port = await freePort()
  const logs = []
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: BRAIN_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      FEISHU_ENABLED: 'false',
      // 显式清空真实密钥：任何漏网的直连都会立刻失败，而不是花用户的额度
      LLM_API_KEY: '',
      WHISPER_API_KEY: '',
      FISH_AUDIO_API_KEY: '',
      TAVILY_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    rmSync(dataDir, { recursive: true, force: true })
  }

  if (!ready) {
    const detail = logs.join('').slice(-4000)
    await stop()
    throw new Error(`brain 启动失败（端口 ${port}）：\n${detail}`)
  }
  return { url, dbPath, logs, stop }
}

/** 建一个独立测试用户，返回 userId */
export async function resolveUser(brainUrl, username) {
  const res = await fetch(`${brainUrl}/api/users/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username })
  })
  if (!res.ok) throw new Error(`创建测试用户失败：HTTP ${res.status}`)
  const json = await res.json()
  return json.userId
}

/** 写入用户配置（provider 指向 mock LLM + 压缩/工作流档位） */
export async function putConfig(brainUrl, userId, patch) {
  const res = await fetch(`${brainUrl}/api/config/${userId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: patch })
  })
  if (!res.ok) throw new Error(`写配置失败：HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * 跑一个文本回合，读完整个 SSE 流。
 * 返回 { events, full, error }；HTTP 层失败直接抛错。
 */
export async function chatTurn(brainUrl, { userId, sessionId, content, timeoutMs = 120_000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${brainUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, sessionId, content }),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`chat HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const events = []
    let buffer = ''
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (!data) continue
        let event
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        events.push(event)
        if (event.type === 'delta') full += event.delta
      }
    }
    const error = events.find((event) => event.type === 'error')
    return { events, full, error }
  } finally {
    clearTimeout(timer)
  }
}

/** 直接写数据库造历史（绕过 UI，用于快速构造"很长的会话"） */
export async function seedMessages(dbPath, sessionId, userId, messages) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const now = Date.now()
    db.prepare(
      'INSERT INTO sessions (id, user_id, channel, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(sessionId, userId, 'desktop', 'seed', now, now)
    // 会话是树：直接造历史也要按线性对话接成一条链，并把活动叶指向最后一条，
    // 否则 listMessages（只走活动世界线）只会看到最后一条
    const insert = db.prepare(
      'INSERT INTO messages (id, session_id, parent_id, role, content, tts_text, mode, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'
    )
    let offset = 0
    let parentId = null
    for (const message of messages) {
      insert.run(message.id, sessionId, parentId, message.role, message.content, 'text', now + offset)
      parentId = message.id
      offset += 1
    }
    db.prepare('UPDATE sessions SET active_leaf_id = ? WHERE id = ?').run(parentId, sessionId)
  } finally {
    db.close()
  }
}
