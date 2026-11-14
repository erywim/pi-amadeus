/**
 * PIAM-6 Relay 本地 E2E：隔离 Brain + 本地假 Relay。
 *
 * 复现/验证的链路（全部本机，不连真实 Relay、Cloudflare、Docker 或模型）：
 *  1. 隔离 DB / 工作区启动 Brain，Relay 默认关闭；
 *  2. /api/relay/* 只允许本机桌面端，Host / Origin / Sec-Fetch-Site / body 校验；
 *  3. 假 WebSocket Relay 收到正确的 token hash 与注册密钥（普通 + E2E 路由 token）；
 *  4. /api/relay/status 永不回显连接码、注册密钥或 token hash；
 *  5. enable → 注册 → reconnect → disable → 再 enable 的生命周期；
 *  6. 经 Relay 隧道的请求不能触达 relay / collaboration 管理端点；
 *  7. SIGTERM 时 Relay 客户端先断开，Brain 干净退出且不再重拨。
 *
 * 用法：node scripts/e2e-relay.mjs
 * 退出码：0 全部通过；1 失败（失败时打印 Brain 尾部日志）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'
import { repository, waitFor } from './agent-test-harness.mjs'

// 用 Brain 自己声明的 ws 依赖解析，避免依赖根目录偶然提升。
const brainRequire = createRequire(join(repository, 'services/brain/package.json'))
const WebSocket = brainRequire('ws')
const { WebSocketServer } = WebSocket

const READY_TIMEOUT_MS = 20_000
const API_TIMEOUT_MS = 5_000
const REGISTER_TIMEOUT_MS = 8_000
const CONNECT_CODE = /^[A-Za-z0-9_-]{16,128}$/
/** 公开状态必须包含的字段；允许产品后续增加 deviceName 等非秘密字段。 */
const PUBLIC_STATUS_KEYS = [
  'activeTunnels',
  'configured',
  'connectedAt',
  'e2eEncryption',
  'enabled',
  'lastError',
  'serverUrl',
  'state'
]
/** 这些字段一旦出现在状态里就是泄露。 */
const SECRET_STATUS_KEYS = ['connectCode', 'registrationKey', 'tokenHash', 'routingToken']

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')

/** 与 services/brain/src/relay/protocol.ts 的 routingToken 同构；测试独立计算，不 import 产品代码。 */
function routingToken(connectCode) {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(connectCode), Buffer.from('alma-relay-e2e/v1/routing'), Buffer.alloc(0), 16)
  ).toString('base64url')
}

function expectedTokenHash(connectCode, e2eEncryption) {
  return sha256Hex(e2eEncryption ? routingToken(connectCode) : connectCode)
}

const hasHeader = (headers, name) =>
  Object.keys(headers).some((key) => key.toLowerCase() === name)

/** 原始 Node HTTP 请求：需要覆盖 Host 头来验证本机守卫，fetch 不允许这类边界测试。 */
function api(base, path, { method = 'GET', headers = {}, body, json, timeout = API_TIMEOUT_MS } = {}) {
  const url = new URL(path, base)
  const outgoing = { ...headers }
  let payload = body
  if (json !== undefined) {
    payload = JSON.stringify(json)
    if (!hasHeader(outgoing, 'content-type')) outgoing['content-type'] = 'application/json'
  }
  if (payload !== undefined && !hasHeader(outgoing, 'content-length')) {
    outgoing['content-length'] = String(Buffer.byteLength(payload))
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: outgoing
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应保留原文 */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: parsed })
      })
    })
    request.setTimeout(timeout, () => request.destroy(new Error(`${method} ${path} timed out`)))
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

function expectStatus(response, expected, label) {
  const accepted = Array.isArray(expected) ? expected : [expected]
  assert.ok(
    accepted.includes(response.status),
    `${label}: expected ${accepted.join('/')}, received ${response.status}: ${response.text.slice(0, 600)}`
  )
}

function assertNoSecrets(payload, secrets, label) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  for (const [name, secret] of secrets) {
    if (!secret) continue
    assert.ok(!text.includes(secret), `${label} must not expose ${name}`)
  }
}

function assertPublicStatus(status, label) {
  for (const key of PUBLIC_STATUS_KEYS) assert.ok(Object.hasOwn(status, key), `${label} missing ${key}`)
  for (const key of SECRET_STATUS_KEYS) assert.ok(!Object.hasOwn(status, key), `${label} must not expose ${key}`)
}

async function unusedPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * 每个阶段独立的 home / bin / skills / workspace / SQLite：不读取用户真实目录，
 * 也不让不同阶段共享 Relay 或 DB 状态。
 */
async function isolatedEnvironment(root, label, relayEnv) {
  const phase = join(root, label)
  const home = join(phase, 'home')
  const skills = join(phase, 'skills')
  const bin = join(phase, 'bin')
  const workspace = join(phase, 'workspace')
  await Promise.all([home, skills, bin, workspace].map((dir) => mkdir(dir, { recursive: true })))
  await writeFile(join(workspace, 'piam-relay-workspace.txt'), 'PIAM_RELAY_WORKSPACE\n')
  // 受控 PATH：只暴露无害的 --version fixture，避免发现并运行本机真实 CLI。
  await symlink(process.execPath, join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode'))
  return {
    dbPath: join(phase, 'brain.sqlite'),
    workspace,
    env: {
      PATH: bin,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_CACHE_HOME: home,
      TMPDIR: phase,
      TMP: phase,
      TEMP: phase,
      LANG: 'C.UTF-8',
      NODE_NO_WARNINGS: '1',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      DB_PATH: join(phase, 'brain.sqlite'),
      SKILLS_DIR: skills,
      BASH_TOOL_CWD: workspace,
      WORKSPACE_DIR: workspace,
      LLM_API_KEY: 'test',
      LLM_BASE_URL: 'http://127.0.0.1:1/v1',
      AI_MODEL: 'piam-test',
      FEISHU_ENABLED: 'false',
      FEISHU_APP_ID: '',
      FEISHU_APP_SECRET: '',
      FEISHU_DOMAIN: 'feishu',
      WHISPER_API_KEY: '',
      WHISPER_BASE_URL: 'http://127.0.0.1:1',
      WHISPER_MODEL: 'test',
      WHISPER_PROXY: '',
      FISH_AUDIO_API_KEY: '',
      FISH_AUDIO_VOICE: '',
      FISH_AUDIO_PROXY: '',
      TTS_ENDPOINT_URL: 'http://127.0.0.1:1',
      TTS_MODEL: 'test',
      TAVILY_API_KEY: '',
      TOOL_CONFIRM_TIMEOUT_MS: '10000',
      RELAY_ENABLED: 'false',
      ...relayEnv
    }
  }
}

async function startBrain({ label, env, dbPath, workspace }) {
  const port = await unusedPort()
  const child = spawn(process.execPath, [join(repository, 'services/brain/src/index.ts')], {
    cwd: repository,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const exit = once(child, 'exit')
  let logs = ''
  const collect = (chunk) => { logs = (logs + chunk).slice(-32_000) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const brain = {
    label,
    base: `http://127.0.0.1:${port}`,
    port,
    child,
    exit,
    dbPath,
    workspace,
    get logs() { return logs },
    get exited() { return child.exitCode !== null || child.signalCode !== null },
    async stop(signal = 'SIGTERM') {
      if (brain.exited) return
      child.kill(signal)
      let timer
      try {
        await Promise.race([exit, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} brain did not exit`)), 5_000)
        })])
      } catch (error) {
        child.kill('SIGKILL')
        await exit
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
  }
  try {
    await waitFor(`${label} brain readiness`, async () => {
      if (brain.exited) throw new Error(`${label} brain exited before readiness:\n${logs}`)
      try {
        const response = await fetch(`${brain.base}/api/health`, { signal: AbortSignal.timeout(500) })
        return response.ok
      } catch { return false }
    }, READY_TIMEOUT_MS)
  } catch (error) {
    await brain.stop().catch(() => {})
    throw error
  }
  return brain
}

/**
 * 只实现测试需要的协议子集：接受 /agent 注册、记录 token hash/注册帧、
 * 向客户端下发 hreq 并收集 hres/hchunk/hend/herr。
 */
class FakeRelay {
  constructor() {
    this.records = []
    this.mode = 'normal'
    this.rejectMessage = 'registration rejected'
    this.nextId = 0
  }

  async start() {
    this.server = createServer((request, response) => {
      if (request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        return
      }
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'no agent tunnel' }))
    })
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    this.server.on('upgrade', (request, socket, head) => {
      let url
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1') } catch { socket.destroy(); return }
      if (url.pathname !== '/agent') { socket.destroy(); return }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(ws, url))
    })
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    this.port = this.server.address().port
    this.url = `ws://127.0.0.1:${this.port}`
    return this
  }

  attach(ws, url) {
    const record = {
      th: url.searchParams.get('th'),
      register: null,
      registered: false,
      frames: [],
      pending: new Map(),
      closed: false,
      closeCode: null,
      closeReason: '',
      ws
    }
    this.records.push(record)
    ws.on('message', (data, isBinary) => {
      if (isBinary) return // Brain 客户端协议 1 只用 JSON 文本帧。
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      record.frames.push(frame)
      if (frame.t === 'register') {
        record.register = frame
        if (this.mode === 'reject') {
          // 故意把连接码和注册密钥放进关闭原因，验证 manager 的 lastError 脱敏。
          const message = this.rejectMessage.slice(0, 120)
          try { ws.send(JSON.stringify({ t: 'error', message })) } catch { /* closed */ }
          try { ws.close(4003, message) } catch { /* closed */ }
        } else {
          record.registered = true
          ws.send(JSON.stringify({ t: 'registered', proto: 1 }))
        }
        return
      }
      const pending = record.pending.get(String(frame.id ?? ''))
      if (!pending) return
      if (frame.t === 'hres') {
        pending.status = Number(frame.status ?? 0)
        pending.headers = frame.headers ?? {}
      } else if (frame.t === 'hchunk') {
        pending.chunks.push(Buffer.from(String(frame.b ?? ''), 'base64'))
      } else if (frame.t === 'hend') {
        pending.done = true
        pending.body = Buffer.concat(pending.chunks).toString('utf8')
      } else if (frame.t === 'herr') {
        pending.done = true
        pending.error = String(frame.message ?? 'relay client error')
      }
    })
    ws.on('close', (code, reason) => {
      record.closed = true
      record.closeCode = code
      record.closeReason = reason.toString()
      for (const pending of record.pending.values()) {
        if (!pending.done) {
          pending.done = true
          pending.error = 'relay connection closed'
        }
      }
    })
    ws.on('error', () => {})
  }

  /** 只统计真正收到 registered 回复的连接；被拒绝的注册尝试不算。 */
  registrations() {
    return this.records.filter((record) => record.registered)
  }

  waitRegister(count, timeout = REGISTER_TIMEOUT_MS) {
    return waitFor(`fake relay registration #${count}`, () => {
      const registered = this.registrations()
      return registered.length >= count ? registered[count - 1] : false
    }, timeout)
  }

  waitClosed(record, timeout = 5_000) {
    return waitFor('fake relay agent socket closed', () => (record.closed ? record : false), timeout)
  }

  async request(record, { method = 'GET', path, headers = {}, timeout = API_TIMEOUT_MS } = {}) {
    assert.equal(record.ws.readyState, WebSocket.OPEN, 'fake relay agent socket must be open')
    const id = `piam-h${++this.nextId}`
    const pending = { id, status: null, headers: {}, chunks: [], done: false, body: undefined, error: undefined }
    record.pending.set(id, pending)
    record.ws.send(JSON.stringify({ t: 'hreq', id, method, path, headers }))
    return waitFor(`tunneled ${method} ${path}`, () => (pending.done ? pending : false), timeout)
  }

  async close() {
    for (const record of this.records) {
      try { record.ws.terminate() } catch { /* already closed */ }
    }
    try { this.wss?.close() } catch { /* already closed */ }
    if (!this.server) return
    this.server.closeAllConnections?.()
    await new Promise((resolve) => this.server.close(() => resolve()))
  }
}

const started = Date.now()
const root = await mkdtemp(join(repository, '.tmp-piam-relay-'))
const brains = new Set()
const relays = new Set()
const failures = []
let passed = 0

/** 单项失败不跳过后面的边界：一次运行把产品缺口全部列出来。 */
async function check(name, test) {
  try {
    await test()
    passed++
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}: ${error.stack ?? error}`)
  }
}

async function launch(label, relayEnv = {}) {
  const setup = await isolatedEnvironment(root, label, relayEnv)
  const brain = await startBrain({ label, ...setup })
  brains.add(brain)
  return brain
}

async function relayStatus(brain) {
  const response = await api(brain.base, '/api/relay/status')
  expectStatus(response, 200, 'GET /api/relay/status')
  return response
}

async function waitRelayState(brain, predicate, label, timeout = REGISTER_TIMEOUT_MS) {
  return waitFor(label, async () => {
    const status = (await relayStatus(brain)).json
    return predicate(status) ? status : false
  }, timeout)
}

async function stopGracefully(brain, fake, label) {
  const record = fake?.registrations().at(-1)
  const exit = brain.exit
  // 状态转移：connected → stopped；由 SIGTERM 触发，客户端必须先断开 Relay 再关库。
  brain.child.kill('SIGTERM')
  if (record && !record.closed) await fake.waitClosed(record)
  let timer
  try {
    await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: brain did not exit after SIGTERM`)), 5_000)
    })])
  } finally {
    // 超时计时器必须清掉，否则脚本结束后事件循环还会被它拖住。
    clearTimeout(timer)
  }
  assert.equal(
    brain.child.exitCode,
    0,
    `${label}: brain must exit 0; logs:\n${brain.logs.slice(-3000)}`
  )
  brains.delete(brain)
  return record
}

try {
  // -------------------------------------------------------------------------
  // 阶段 1：默认关闭 + 本机控制面边界
  // -------------------------------------------------------------------------
  const defaultBrain = await launch('default')

  await check('isolated Brain starts with fresh DB/workspace and relay disabled by default', async () => {
    const health = await api(defaultBrain.base, '/api/health')
    expectStatus(health, 200, 'health')
    assert.equal(health.json.ok, true)

    const database = await readFile(defaultBrain.dbPath)
    assert.equal(database.subarray(0, 15).toString('utf8'), 'SQLite format 3', 'isolated SQLite must be initialized')

    const info = await api(defaultBrain.base, '/api/workspace/info')
    expectStatus(info, 200, 'workspace info')
    assert.equal(info.json.root, defaultBrain.workspace, 'workspace must be the isolated directory')
    const tree = await api(defaultBrain.base, '/api/workspace/tree')
    expectStatus(tree, 200, 'workspace tree')
    assert.ok(
      tree.json.entries.some((entry) => entry.path === 'piam-relay-workspace.txt'),
      'isolated workspace marker must be visible'
    )

    const status = (await relayStatus(defaultBrain)).json
    assert.equal(status.configured, false)
    assert.equal(status.enabled, false)
    assert.ok(status.serverUrl === null || status.serverUrl === '', 'unconfigured relay has no server URL')
    assert.equal(status.e2eEncryption, true)
    assert.equal(status.state, 'stopped')
    assert.equal(status.lastError, null)
    assert.equal(status.connectedAt, null)
    assert.equal(status.activeTunnels, 0)
    assertPublicStatus(status, 'default relay status')
  })

  await check('relay control routes are loopback-only and reject hostile browser contexts', async () => {
    expectStatus(
      await api(defaultBrain.base, '/api/relay/status', { headers: { host: 'untrusted.example' } }),
      403,
      'untrusted Host'
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/status', { headers: { origin: 'https://untrusted.example' } }),
      403,
      'untrusted Origin'
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/status', { headers: { origin: 'null' } }),
      403,
      'opaque Origin'
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/status', { headers: { 'sec-fetch-site': 'cross-site' } }),
      403,
      'cross-site fetch'
    )
    const trusted = await api(defaultBrain.base, '/api/relay/status', {
      headers: {
        origin: 'http://127.0.0.1:5173',
        'sec-fetch-site': 'same-origin',
        // 伪造转发头不能改变“只信真实 loopback 对端”的结论。
        'x-forwarded-for': '203.0.113.9'
      }
    })
    expectStatus(trusted, 200, 'loopback Origin')
    assert.equal(trusted.headers['cache-control'], 'no-store', 'relay control responses must not be cached')
  })

  await check('relay control validates JSON bodies and refuses to enable without configuration', async () => {
    expectStatus(
      await api(defaultBrain.base, '/api/relay/enable', {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}'
      }),
      415,
      'non-JSON content type'
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
      }),
      400,
      'malformed JSON'
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/enable', { method: 'POST', json: [] }),
      400,
      'array body'
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null'
      }),
      400,
      'null body'
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/enable', { method: 'POST', json: { padding: 'x'.repeat(5_000) } }),
      413,
      'oversized body'
    )

    // 没有任何 Relay 配置时，空 body 的启用必须被拒绝，不能留下半开的客户端。
    const refused = await api(defaultBrain.base, '/api/relay/enable', { method: 'POST', json: {} })
    expectStatus(refused, 409, 'enable without configuration')
    assert.ok(
      !/connectCode|registrationKey|tokenHash/.test(refused.text),
      `enable error must not echo secret field names: ${refused.text}`
    )
    expectStatus(
      await api(defaultBrain.base, '/api/relay/reconnect', { method: 'POST', json: {} }),
      409,
      'reconnect while disabled'
    )
    // 未启用时 disable 是幂等的，不报错。
    expectStatus(
      await api(defaultBrain.base, '/api/relay/disable', { method: 'POST', json: {} }),
      200,
      'disable while already disabled'
    )
  })

  await defaultBrain.stop()
  brains.delete(defaultBrain)

  // -------------------------------------------------------------------------
  // 阶段 2：配置存在但默认不拨号 → 显式启用的完整生命周期
  // -------------------------------------------------------------------------
  const fake = await new FakeRelay().start()
  relays.add(fake)
  const connectCode = randomBytes(32).toString('base64url')
  const registrationKey = randomBytes(24).toString('hex')
  const tokenHash = expectedTokenHash(connectCode, false)
  const deviceName = 'piam-relay-device'
  assert.match(connectCode, CONNECT_CODE)
  const configuredBrain = await launch('configured', {
    RELAY_ENABLED: 'false',
    RELAY_URL: fake.url,
    RELAY_CONNECT_CODE: connectCode,
    RELAY_REGISTRATION_KEY: registrationKey,
    RELAY_E2E_ENCRYPTION: 'false',
    RELAY_USER_ID: 'relay-owner',
    RELAY_NAME: deviceName
  })
  const secrets = [
    ['connect code', connectCode],
    ['registration key', registrationKey],
    ['token hash', tokenHash]
  ]

  await check('configured relay stays stopped until explicitly enabled and status redacts secrets', async () => {
    const status = (await relayStatus(configuredBrain)).json
    assert.equal(status.configured, true)
    assert.equal(status.enabled, false)
    assert.equal(status.serverUrl, fake.url)
    assert.equal(status.e2eEncryption, false)
    assert.equal(status.state, 'stopped')
    assert.equal(status.connectedAt, null)
    assert.equal(status.activeTunnels, 0)
    assert.equal(fake.registrations().length, 0, 'default-disabled relay must not dial the server')
    assertPublicStatus(status, 'configured relay status')
    assertNoSecrets(status, secrets, 'relay status while stopped')
  })

  await check('enable dials the fake relay with hashed code, registration key and device name', async () => {
    const response = await api(configuredBrain.base, '/api/relay/enable', { method: 'POST', json: {} })
    expectStatus(response, 200, 'enable')
    assert.equal(response.json.enabled, true)
    assertNoSecrets(response.text, secrets, 'enable response')

    const record = await fake.waitRegister(1)
    assert.equal(record.th, tokenHash, 'agent URL must carry sha256(connect code)')
    assert.match(record.th, /^[a-f0-9]{64}$/)
    assert.equal(record.register.tokenHash, tokenHash)
    assert.equal(record.register.key, registrationKey, 'registration key must reach the relay')
    assert.equal(record.register.name, deviceName)
    assert.ok(Number(record.register.proto) >= 1, 'client must negotiate protocol 1 or newer')
    assert.ok(!JSON.stringify(record.frames).includes(connectCode), 'relay must never see the raw connect code')

    const status = await waitRelayState(
      configuredBrain,
      (value) => value.state === 'connected' && value.connectedAt !== null,
      'relay connected'
    )
    assert.equal(status.lastError, null)
    assert.equal(status.activeTunnels, 0)
    assertNoSecrets(status, secrets, 'connected relay status')
  })

  await check('enable is idempotent and does not open a second agent socket', async () => {
    const before = fake.records.length
    const response = await api(configuredBrain.base, '/api/relay/enable', { method: 'POST', json: {} })
    expectStatus(response, 200, 'second enable')
    await delay(200)
    assert.equal(fake.records.length, before, 'a second enable must not create another tunnel')
  })

  await check('reconnect replaces the agent socket and registers again', async () => {
    const previous = fake.registrations().at(-1)
    const before = fake.records.length
    const response = await api(configuredBrain.base, '/api/relay/reconnect', { method: 'POST', json: {} })
    expectStatus(response, 200, 'reconnect')
    const record = await fake.waitRegister(2)
    assert.ok(fake.records.length > before, 'reconnect must open a new agent socket')
    assert.notEqual(record, previous)
    assert.equal(record.th, tokenHash)
    assert.equal(record.register.key, registrationKey)
    await fake.waitClosed(previous)
    assert.equal(previous.closeCode, 1000, 'replaced socket must close cleanly')
    const status = await waitRelayState(
      configuredBrain,
      (value) => value.state === 'connected' && value.connectedAt !== null,
      'relay reconnected'
    )
    assertNoSecrets(status, secrets, 'reconnected relay status')
  })

  await check('disable stops the tunnel and never redials on its own', async () => {
    const active = fake.registrations().at(-1)
    // 状态转移：connected → stopped；显式 disable 触发，必须断开并停止重连。
    const response = await api(configuredBrain.base, '/api/relay/disable', { method: 'POST', json: {} })
    expectStatus(response, 200, 'disable')
    assert.deepEqual(response.json, { ok: true })
    await fake.waitClosed(active)
    assert.equal(active.closeCode, 1000, 'disable must close the agent socket cleanly')
    const status = (await relayStatus(configuredBrain)).json
    assert.equal(status.enabled, false)
    assert.equal(status.state, 'stopped')
    assert.equal(status.connectedAt, null)
    assert.equal(status.activeTunnels, 0)
    assertNoSecrets(status, secrets, 'disabled relay status')

    const count = fake.records.length
    // 观察一个完整的最短重连窗口（1s）：停止的客户端不允许自行重拨。
    await delay(1_200)
    assert.equal(fake.records.length, count, 'disabled relay must not reconnect')
  })

  await check('re-enable after disable starts a fresh tunnel', async () => {
    const response = await api(configuredBrain.base, '/api/relay/enable', { method: 'POST', json: {} })
    expectStatus(response, 200, 're-enable')
    const record = await fake.waitRegister(3)
    assert.equal(record.th, tokenHash)
    assert.equal(record.register.key, registrationKey)
    await waitRelayState(configuredBrain, (value) => value.state === 'connected', 'relay reconnected after disable')
  })

  await check('status sanitizes connect code and registration key from relay errors', async () => {
    // 假 Relay 在注册时主动拒绝，并把两个秘密放进关闭原因；对外状态必须脱敏。
    fake.mode = 'reject'
    fake.rejectMessage = `bad key=${registrationKey} code=${connectCode}`
    expectStatus(
      await api(configuredBrain.base, '/api/relay/reconnect', { method: 'POST', json: {} }),
      200,
      'reconnect to rejecting relay'
    )
    const status = await waitRelayState(
      configuredBrain,
      (value) => typeof value.lastError === 'string' && value.lastError.length > 0,
      'relay error reported'
    )
    assert.match(status.lastError, /已隐藏/, `lastError must be redacted: ${status.lastError}`)
    assertNoSecrets(status, secrets, 'relay status after relay error')
    assert.ok(status.lastError.length <= 301, 'lastError must be length-capped')
    fake.mode = 'normal'
    expectStatus(
      await api(configuredBrain.base, '/api/relay/disable', { method: 'POST', json: {} }),
      200,
      'disable after relay error'
    )
  })

  await check('re-enable restores the normal tunnel after an error', async () => {
    expectStatus(
      await api(configuredBrain.base, '/api/relay/enable', { method: 'POST', json: {} }),
      200,
      'enable after error'
    )
    const record = await fake.waitRegister(4)
    assert.equal(record.th, tokenHash)
    assert.equal(record.register.key, registrationKey)
    await waitRelayState(configuredBrain, (value) => value.state === 'connected', 'relay recovered')
  })

  await check('tunneled requests cannot reach relay or collaboration admin endpoints', async () => {
    const record = fake.registrations().at(-1)
    // 先证明隧道本身可用；否则后面每个 403 都可能是隧道坏了。
    const health = await fake.request(record, { method: 'GET', path: '/api/health' })
    assert.equal(health.error, undefined, 'tunneled health request must not fail')
    assert.equal(health.status, 200, 'tunneled health request must reach the local Brain')
    assert.equal(JSON.parse(health.body).ok, true)

    // 伪造浏览器/代理头也不能让管理端点通过 Relay 隧道。
    const spoofed = {
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '127.0.0.1',
      'x-piam-relay': '0'
    }
    const attempts = [
      ['GET', '/api/relay/status'],
      ['POST', '/api/relay/enable'],
      ['GET', '/api/collaboration/status?userId=piam-relay'],
      ['POST', '/api/collaboration/enable'],
      ['POST', '/api/relay/disable']
    ]
    for (const [method, path] of attempts) {
      const response = await fake.request(record, { method, path, headers: spoofed })
      if (response.error) continue // 客户端直接拒绝也算没有触达管理面。
      assert.ok(
        response.status >= 400,
        `${method} ${path} must not be reachable through the relay tunnel; received ${response.status} ${response.body?.slice(0, 200) ?? ''}`
      )
    }

    // 路径/方法必须在客户端本地被拒绝，不进入 Brain。
    for (const path of ['//evil.example/api/relay/status', '/healthz', '/api/../api/relay/status']) {
      const invalid = await fake.request(record, { method: 'GET', path })
      assert.equal(invalid.error, undefined, `${path} must receive an HTTP rejection, not a transport error`)
      assert.equal(invalid.status, 403, `${path} must be rejected as an out-of-policy path`)
    }
    const badMethod = await fake.request(record, { method: 'TRACE', path: '/api/health' })
    assert.equal(badMethod.error, undefined)
    assert.equal(badMethod.status, 405, 'non-allowlisted methods must be rejected')
  })

  await check('SIGTERM closes the relay tunnel, exits cleanly and does not redial', async () => {
    const active = fake.registrations().at(-1)
    const before = fake.records.length
    const closed = await stopGracefully(configuredBrain, fake, 'configured brain')
    assert.equal(closed.closeCode, 1000, 'shutdown must close the agent tunnel cleanly')
    await delay(1_200)
    assert.equal(fake.records.length, before, 'shutdown must not reconnect')
    assert.ok(active.closed)
  })

  // -------------------------------------------------------------------------
  // 阶段 3：RELAY_ENABLED=true 自动拨号 + E2E routing token 哈希
  // -------------------------------------------------------------------------
  const e2eRelay = await new FakeRelay().start()
  relays.add(e2eRelay)
  const e2eCode = randomBytes(32).toString('base64url')
  const e2eKey = randomBytes(24).toString('hex')
  const e2eHash = expectedTokenHash(e2eCode, true)
  assert.match(e2eCode, CONNECT_CODE)
  const e2eBrain = await launch('e2e', {
    RELAY_ENABLED: 'true',
    RELAY_URL: e2eRelay.url,
    RELAY_CONNECT_CODE: e2eCode,
    RELAY_REGISTRATION_KEY: e2eKey,
    RELAY_E2E_ENCRYPTION: 'true',
    RELAY_USER_ID: 'relay-owner',
    RELAY_NAME: 'piam-relay-e2e-device'
  })
  const e2eSecrets = [
    ['connect code', e2eCode],
    ['registration key', e2eKey],
    ['routing-derived token hash', e2eHash]
  ]

  await check('RELAY_ENABLED=true auto-dials with the E2E routing token hash', async () => {
    const record = await e2eRelay.waitRegister(1)
    assert.equal(record.th, e2eHash, 'E2E mode must register sha256(hkdf routing token), not the raw code')
    assert.notEqual(record.th, sha256Hex(e2eCode))
    assert.match(routingToken(e2eCode), /^[A-Za-z0-9_-]+$/)
    assert.equal(record.register.tokenHash, e2eHash)
    assert.equal(record.register.key, e2eKey)
    assert.equal(record.register.name, 'piam-relay-e2e-device')
    const status = await waitRelayState(e2eBrain, (value) => value.state === 'connected', 'e2e relay connected')
    assert.equal(status.enabled, true)
    assert.equal(status.e2eEncryption, true)
    assert.equal(status.configured, true)
    assertNoSecrets(status, e2eSecrets, 'e2e relay status')
  })

  await check('E2E mode refuses plaintext tunneled requests before they reach the Brain', async () => {
    const record = e2eRelay.registrations().at(-1)
    for (const path of ['/api/health', '/api/relay/status', '/api/collaboration/status?userId=piam-relay']) {
      const response = await e2eRelay.request(record, { method: 'GET', path })
      // PROTOCOL.md：启用 E2E 后桌面只接受加密 tunnel，明文 hreq 一律 403。
      assert.ok(
        response.error || response.status === 403,
        `E2E mode must refuse plaintext ${path}; received ${response.status ?? response.error}`
      )
    }
  })

  await check('auto-started relay also shuts down gracefully on SIGTERM', async () => {
    const before = e2eRelay.records.length
    const closed = await stopGracefully(e2eBrain, e2eRelay, 'e2e brain')
    assert.equal(closed.closeCode, 1000)
    await delay(1_200)
    assert.equal(e2eRelay.records.length, before, 'shutdown must not reconnect')
  })

  const total = passed + failures.length
  console.log(`=== relay: ${passed}/${total} passed (${Date.now() - started}ms) ===`)
  if (failures.length > 0) {
    console.error(`失败项：\n${failures.map((failure) => `  - ${failure.name}`).join('\n')}`)
    for (const brain of brains) console.error(`--- ${brain.label} brain log ---\n${brain.logs.slice(-5000)}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`FAIL  relay: ${error.stack ?? error}`)
  for (const brain of brains) console.error(`--- ${brain.label} brain log ---\n${brain.logs.slice(-5000)}`)
  process.exitCode = 1
} finally {
  for (const brain of brains) await brain.stop().catch(() => {})
  for (const relay of relays) await relay.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
