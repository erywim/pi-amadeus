/** PIAM-6 独立集成环境：只访问新建 SQLite/目录、可信 Node fixture 和回环 mock LLM。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const fixturePath = join(repository, 'scripts/fixtures/agent-runner.mjs')
export const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export function approvalCommand(kind) {
  if (kind === 'long') return `printf PIAM_HIDDEN_PREFIX #${' '.repeat(17 * 1024)}\nprintf visible`
  const prefix = 'printf PIAM_BOUNDARY_OK #'
  const remaining = 16 * 1024 - Buffer.byteLength(prefix)
  const boundary = prefix + '界'.repeat(Math.floor(remaining / 3)) + ' '.repeat(remaining % 3)
  return kind === 'over-boundary' ? `${boundary}x` : boundary
}

export async function waitFor(label, probe, timeout = 8000) {
  const deadline = Date.now() + timeout
  let last
  do {
    last = await probe()
    if (last) return last
    // 按可观察条件重试，不依赖固定时长猜测任务是否完成。
    await delay(25)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`)
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function unusedPort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

async function closeServer(server) {
  server.closeAllConnections()
  await new Promise((resolveClose) => server.close(resolveClose))
}

export async function createHarness({ label = 'agents', brainEntry = process.env.E2E_BRAIN_ENTRY } = {}) {
  const root = await mkdtemp(join(repository, `.tmp-piam-${label}-`))
  const requests = []
  const mockErrors = []
  const streams = new Set()
  const directories = new Set([root])
  let child
  let childExit
  let logs = ''
  let counter = 0
  let cleaned = false

  const mock = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions', 'LLM must use the isolated mock endpoint')
      assert.equal(req.headers.authorization, 'Bearer test', 'real API credentials must not enter tests')
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      requests.push(body)
      const userText = body.messages.filter((message) => message.role === 'user')
        .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
      const toolResults = body.messages.filter((message) => message.role === 'tool')
      const approvalCount = userText.includes('PIAM_APPROVAL_DOUBLE') ? 2 : userText.includes('PIAM_APPROVAL') ? 1 : 0
      const needTool = toolResults.length < approvalCount
      const toolRound = toolResults.length + 1
      const command = userText.includes('PIAM_APPROVAL_LONG') ? approvalCommand('long')
        : userText.includes('PIAM_APPROVAL_OVER_BOUNDARY') ? approvalCommand('over-boundary')
          : userText.includes('PIAM_APPROVAL_BOUNDARY') ? approvalCommand('boundary')
            : approvalCount === 2 ? `printf piam-approved-${toolRound}` : 'printf piam-approved'
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
        id: `piam-mock-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'piam-test',
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`)
      chunk({ role: 'assistant' })
      if (needTool) {
        chunk({ tool_calls: [{ index: 0, id: `piam-bash-confirm-${toolRound}`, type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({ command })
        } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ content: 'PIAM_MOCK_' })
        chunk({ content: 'DONE' })
        chunk({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    } catch (error) {
      mockErrors.push(error)
      res.writeHead(500)
      res.end(String(error))
    }
  })

  let base
  async function request(path, { method = 'GET', body, status = 200, headers = {}, base: target = base } = {}) {
    const response = await fetch(`${target}${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
    })
    const text = await response.text()
    const expected = Array.isArray(status) ? status : [status]
    assert.ok(expected.includes(response.status), `${method} ${path}: expected ${expected}, received ${response.status}: ${text.slice(0, 800)}`)
    return text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text || null
  }

  async function events(path, { base: target = base, headers = {} } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    let response
    try {
      response = await fetch(`${target}${path}`, { headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    assert.equal(response.status, 200, `SSE ${path}: ${response.status}`)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const stream = { values: [], closed: false, error: null, stop: () => controller.abort() }
    streams.add(stream)
    stream.done = (async () => {
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for await (const bytes of response.body) {
          buffer += decoder.decode(bytes, { stream: true }).replace(/\r/g, '')
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
            if (data) stream.values.push(JSON.parse(data))
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) stream.error = error
      } finally {
        // 观察连接结束不触发 stop；任务的生命周期由 HTTP 动作独立控制。
        stream.closed = true
        streams.delete(stream)
      }
    })()
    return stream
  }

  async function stopBrain(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    // 只终止本脚本 spawn 返回的那个子进程，不按名称杀进程。
    child.kill(signal)
    let timer
    try {
      await Promise.race([childExit, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('brain child did not exit')), 5000)
      })])
    } catch (error) {
      child.kill('SIGKILL')
      await childExit
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  const harness = {
    root, mockRequests: requests, mockErrors, fixturePath, request, events,
    get base() { return base },
    get logs() { return logs },
    get pid() { return child?.pid },
    async dir(name = `cwd-${++counter}`) {
      const path = join(root, name)
      await mkdir(path, { recursive: true })
      directories.add(path)
      return path
    },
    async release(path) { await writeFile(path, 'release\n') },
    directive(options = {}) { return `PIAM_FIXTURE:${JSON.stringify(options)}` },
    id() { return `piam-${label}-${++counter}` },
    async user(name = harness.id()) {
      return (await request('/api/users/resolve', { method: 'POST', body: { username: name } })).userId
    },
    profileInput(overrides = {}) {
      return {
        name: harness.id(), runtime: 'custom', command: process.execPath, args: [fixturePath], promptMode: 'stdin',
        instructions: '', model: '', enabled: true, allowRemote: false, ...overrides
      }
    },
    async profile(overrides = {}) {
      return (await request('/api/agents/profiles', { method: 'POST', status: 201, body: harness.profileInput(overrides) })).profile
    },
    async task(userId, agentId, overrides = {}) {
      return (await request('/api/agents/tasks', { method: 'POST', status: 201, body: {
        userId, agentId, title: harness.id(), prompt: harness.directive(), cwd: await harness.dir(), requestId: harness.id(), ...overrides
      } })).task
    },
    async getTask(id, userId) { return (await request(`/api/agents/tasks/${id}?userId=${encodeURIComponent(userId)}`)).task },
    async waitTask(id, userId, predicate = (task) => terminal.has(task.status)) {
      let last
      try {
        return await waitFor(`task ${id}`, async () => {
          last = await harness.getTask(id, userId)
          return predicate(last) ? last : false
        })
      } catch (error) {
        throw new Error(`${error.message}; task=${JSON.stringify(last)}; brain=${logs.slice(-3000)}`)
      }
    },
    approval(task) {
      assert.ok(task.pendingApproval, 'task must have a live approval')
      const { turnId, toolCallId } = task.pendingApproval
      return { turnId, toolCallId }
    },
    async action(id, action, body) {
      return (await request(`/api/agents/tasks/${id}/${action}`, { method: 'POST', status: action === 'resume' ? 201 : 200, body })).task
    },
    async starts(cwd) {
      const raw = await readFile(join(cwd, '.fixture-starts.jsonl'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      return raw.trim() ? raw.trim().split('\n').map((line) => JSON.parse(line)) : []
    },
    stopBrain,
    async restart({ crash = false } = {}) {
      // 崩溃恢复用 SIGKILL 模拟真正丢失内存状态；重启仍复用同一个隔离 DB。
      await stopBrain(crash ? 'SIGKILL' : 'SIGTERM')
      await startBrain()
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      for (const stream of streams) stream.stop()
      await Promise.all([...streams].map((stream) => stream.done))
      try {
        await stopBrain()
      } finally {
        try {
          // 任一断言失败也等 fixture 进程退出；不把资源清理责任推给下一个运行。
          const pids = new Set((await Promise.all([...directories].map((cwd) => harness.starts(cwd))))
            .flat().map((start) => start.pid))
          await waitFor('all owned fixture processes exited', () => [...pids].every((pid) => {
            try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
          }), 5000)
        } finally {
          await closeServer(mock)
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  }

  const mockPort = await listen(mock)
  const port = await unusedPort()
  base = `http://127.0.0.1:${port}`
  const home = await harness.dir('home')
  const skills = await harness.dir('skills')
  const bin = await harness.dir('bin')
  // 受控 PATH：只发现无害的 --version fixture，绝不运行本机真实 CLI 或读取它们的登录态。
  await symlink(process.execPath, join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode'))
  const environment = {
    PATH: bin, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    TMPDIR: root, TMP: root, TEMP: root, LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PORT: String(port), DB_PATH: join(root, 'brain.sqlite'), SKILLS_DIR: skills, BASH_TOOL_CWD: root,
    LLM_API_KEY: 'test', LLM_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, AI_MODEL: 'piam-test',
    FEISHU_ENABLED: 'false', FEISHU_APP_ID: '', FEISHU_APP_SECRET: '', FEISHU_DOMAIN: 'feishu',
    WHISPER_API_KEY: '', WHISPER_BASE_URL: `http://127.0.0.1:${mockPort}`, WHISPER_MODEL: 'test', WHISPER_PROXY: '',
    FISH_AUDIO_API_KEY: '', FISH_AUDIO_VOICE: '', FISH_AUDIO_PROXY: '', TTS_ENDPOINT_URL: `http://127.0.0.1:${mockPort}`, TTS_MODEL: 'test',
    TAVILY_API_KEY: '', TOOL_CONFIRM_TIMEOUT_MS: '10000'
  }

  async function startBrain() {
    const entry = resolve(brainEntry ?? join(repository, 'services/brain/src/index.ts'))
    child = spawn(process.execPath, [entry], { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    childExit = once(child, 'exit')
    child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-32_000) })
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-32_000) })
    await waitFor('isolated brain readiness', async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`brain exited before readiness: ${logs}`)
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })
        return response.ok
      } catch { return false }
    }, 15000)
  }
  try {
    await startBrain()
    return harness
  } catch (error) {
    await harness.cleanup()
    throw error
  }
}

export async function runCases(label, run) {
  const started = Date.now()
  let harness
  let passed = 0
  const check = async (name, test) => {
    await test()
    passed++
    console.log(`PASS  ${name}`)
  }
  try {
    harness = await createHarness({ label })
    await run(harness, check)
    assert.deepEqual(harness.mockErrors, [], 'mock received only valid isolated LLM requests')
    console.log(`=== ${label}: ${passed}/${passed} passed (${Date.now() - started}ms) ===`)
  } catch (error) {
    console.error(`FAIL  ${label}: ${error.stack ?? error}`)
    if (harness) console.error(harness.logs.slice(-5000))
    process.exitCode = 1
  } finally {
    await harness?.cleanup()
  }
}
