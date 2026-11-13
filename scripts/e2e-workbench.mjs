/**
 * Agent 工作台 GUI E2E（CDP 驱动真实 Electron 应用）：
 *  1. 布局：模型服务条 / 阶段管线 / 会话运行图 / 右侧面板 / 底部状态条
 *  2. 模型服务条：真实服务 chip → 点击激活 → 服务端 active 一致
 *  3. 运行图：多会话泳道、真实节点、点击泳道切换会话
 *  4. 阶段与光线：真实 bash 回合中阶段推进、流动边框出现、状态条显示生成中
 *  5. 终端：展示本轮真实 bash 命令与输出
 *  6. 工件：右侧工件页提取 HTML 代码块并在沙箱 iframe 预览
 *  7. 右侧面板可收起 / 展开
 *
 * 前置：brain（默认 3002）与桌面端 dev（CDP 默认 9222，可用 CDP_HTTP 覆盖）已启动。
 * 脚本自建用户、会话与模型服务，结束统一清理。
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
async function api(path, options) {
  const res = await fetch(`${BRAIN}${path}`, options)
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text }
  }
}
function readEnv(url) {
  try {
    const text = readFileSync(url, 'utf8')
    const map = {}
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) map[match[1]] = match[2]
    }
    return map
  } catch {
    return {}
  }
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
const target = targets.find((item) => item.type === 'page')
if (!target) {
  console.error('未找到 Electron 页面目标。确认桌面端 dev 已启动。')
  process.exit(1)
}
const cdp = await new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onopen = () =>
    resolve({
      call(method, params = {}) {
        return new Promise((resP, rej) => {
          const callId = ++id
          pending.set(callId, { resP, rej })
          ws.send(JSON.stringify({ id: callId, method, params }))
        })
      },
      close: () => ws.close()
    })
  ws.onerror = (error) => reject(new Error(`CDP 失败: ${error.message}`))
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resP, rej } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) rej(new Error(message.error.message))
      else resP(message.result)
    }
  }
})
async function evalJs(expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(
      `页面脚本异常: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`
    )
  }
  return result.result.value
}
async function waitFor(expression, timeoutMs = 30_000, label = expression) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(expression)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(200)
  }
}

const stamp = Date.now()
const username = `e2e-wb-${stamp}`
const createdSessions = []
const createdProviders = []
let userId = ''

async function cleanup() {
  for (const id of createdSessions) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdProviders) {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
}
let cleaned = false
async function cleanupOnce() {
  if (cleaned) return
  cleaned = true
  await cleanup().catch((error) =>
    console.warn(`[e2e] 清理失败：${error instanceof Error ? error.message : error}`)
  )
}
process.on('SIGINT', () => void cleanupOnce().then(() => process.exit(130)))
process.on('SIGTERM', () => void cleanupOnce().then(() => process.exit(143)))

try {
  const login = await api('/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
  userId = login.body.userId
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().userId === ${JSON.stringify(userId)}`,
    20_000,
    '身份同步'
  )
  await evalJs(
    `window.history.pushState({}, '', '/text'); window.dispatchEvent(new PopStateEvent('popstate')); true`
  )
  await sleep(1500)

  // ================= 1. 工作台布局 =================
  // 没有活跃会话时中间是欢迎页，阶段管线/右侧面板在有会话后才挂载
  const shell = await evalJs(`(() => ({
    workbench: !!document.querySelector('[data-testid="workbench"]'),
    providers: !!document.querySelector('[data-testid="provider-strip"]'),
    status: !!document.querySelector('[data-testid="workbench-status"]')
  }))()`)
  report(
    '布局：工作台外壳 / 模型条 / 状态条齐全',
    shell.workbench && shell.providers && shell.status,
    JSON.stringify(shell)
  )

  // ================= 2. 模型服务 chip =================
  const envMap = readEnv(new URL('../services/brain/.env', import.meta.url))
  if (!envMap.LLM_API_KEY || !envMap.LLM_BASE_URL) {
    report('模型条：真实服务 chip（跳过：.env 无 LLM 配置）', true, 'not run')
  } else {
    const provider = await api('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `E2E 工作台服务 ${stamp}`,
        baseUrl: envMap.LLM_BASE_URL,
        model: envMap.AI_MODEL || 'deepseek-v4-pro',
        apiKey: envMap.LLM_API_KEY,
        priority: 1
      })
    })
    const providerId = provider.body.provider?.id
    createdProviders.push(providerId)
    await evalJs(
      `(() => { const store = window.__amadeus.providerStore; store.setState({ loaded: false }); return store.getState().load() })()`
    )
    await waitFor(
      `!!document.querySelector('[data-testid="provider-chip"][data-provider-id="${providerId}"]')`,
      15_000,
      '模型 chip'
    )
    await evalJs(
      `document.querySelector('[data-testid="provider-chip"][data-provider-id="${providerId}"]').click(); true`
    )
    const activeChip = await waitFor(
      `document.querySelector('[data-testid="provider-chip"][data-provider-id="${providerId}"]')?.getAttribute('data-active') === 'true'`,
      15_000,
      'chip 激活'
    ).catch(() => false)
    const providers = await api('/api/providers')
    const serverActive = providers.body.providers?.find((item) => item.id === providerId)?.active
    report('模型条：点击 chip 激活并落到服务端', Boolean(activeChip) && serverActive === true)
  }

  // ================= 3. 多会话运行图 =================
  const sessionA = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessions.push(sessionA)
  await sleep(300)
  const sessionB = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessions.push(sessionB)
  await sleep(600)
  await waitFor(`document.querySelectorAll('[data-testid="run-lane"]').length >= 2`, 10_000, '泳道')
  const lanes = await evalJs(`document.querySelectorAll('[data-testid="run-lane"]').length`)
  report('运行图：每个会话一条泳道', lanes >= 2, `lanes=${lanes}`)
  const sessionUi = await evalJs(`(() => ({
    stage: !!document.querySelector('[data-testid="stage-pipeline"]'),
    panel: !!document.querySelector('[data-testid="workbench-side-panel"]'),
    graph: !!document.querySelector('[data-testid="run-graph"]')
  }))()`)
  report(
    '布局：有会话后阶段管线 / 右侧面板 / 运行图挂载',
    sessionUi.stage && sessionUi.panel && sessionUi.graph,
    JSON.stringify(sessionUi)
  )

  await evalJs(
    `window.__amadeus.sessionStore.getState().selectSession(${JSON.stringify(sessionA)})`
  )
  await sleep(400)
  await evalJs(`(() => {
    const lane = [...document.querySelectorAll('[data-testid="run-lane"]')].find(el => el.dataset.laneSessionId === ${JSON.stringify(sessionB)})
    lane?.querySelector('button')?.click(); return !!lane
  })()`)
  await waitFor(
    `window.__amadeus.sessionStore.getState().activeSessionId === ${JSON.stringify(sessionB)}`,
    5_000,
    '切换泳道'
  )
  report('运行图：点击泳道切换会话', true)

  // ================= 4. 阶段 / 光线 / 状态条 =================
  await evalJs(`window.__amadeus.sessionStore.getState().selectSession(${JSON.stringify(sessionA)})`)
  await sleep(300)
  await evalJs(
    `window.__amadeus.sessionStore.getState().sendMessage('请用 bash 执行 echo e2e-workbench，然后只回复命令输出。')`
  )
  const confirm = await waitFor(
    `!!document.querySelector('[data-testid="bash-confirm-approve"]')`,
    120_000,
    'bash 确认'
  ).catch(() => false)
  report('阶段：真实回合触发工具确认', Boolean(confirm))
  if (confirm) {
    await evalJs(`document.querySelector('[data-testid="bash-confirm-approve"]').click(); true`)
  }

  const observed = { border: false, streamingStatus: false, phases: [], sawStreaming: false }
  const deadline = Date.now() + 180_000
  for (;;) {
    const snap = await evalJs(`(() => {
      const s = window.__amadeus.sessionStore.getState();
      return {
        streaming: s.stream.streaming,
        phase: document.querySelector('[data-testid="stage-pipeline"]')?.getAttribute('data-phase') ?? '',
        border: !!document.querySelector('[data-testid="running-border"]'),
        status: document.querySelector('[data-testid="status-streaming"]')?.getAttribute('data-streaming') ?? ''
      };
    })()`)
    if (snap.streaming) observed.sawStreaming = true
    if (snap.border) observed.border = true
    if (snap.status === 'true') observed.streamingStatus = true
    if (snap.phase && !observed.phases.includes(snap.phase)) observed.phases.push(snap.phase)
    if (!snap.streaming && observed.sawStreaming) break
    if (Date.now() > deadline) throw new Error('等待回合结束超时')
    await sleep(120)
  }
  report(
    '阶段：随真实回合推进',
    observed.phases.some((phase) => ['think', 'tool', 'reply'].includes(phase)),
    observed.phases.join(' → ')
  )
  report('光线：流式期间出现流动边框', observed.border)
  report('状态条：流式期间显示生成中', observed.streamingStatus)
  await waitFor(
    `document.querySelector('[data-testid="stage-done"]')?.getAttribute('data-state') === 'active'`,
    15_000,
    '完成阶段'
  )
  report('阶段：回合结束点亮完成', true)
  report('光线：回合结束移除流动边框', !(await evalJs(`!!document.querySelector('[data-testid="running-border"]')`)))

  // ================= 5. 终端 =================
  await evalJs(`document.querySelector('[data-testid="panel-tab-terminal"]').click(); true`)
  await waitFor(`document.querySelectorAll('[data-testid="terminal-entry"]').length >= 1`, 10_000, '终端条目')
  const terminalText = await evalJs(
    `document.querySelector('[data-testid="terminal-panel"]')?.innerText ?? ''`
  )
  report(
    '终端：显示真实 bash 命令与输出',
    terminalText.includes('echo e2e-workbench') && terminalText.includes('e2e-workbench'),
    terminalText.slice(0, 80).replace(/\n/g, ' / ')
  )

  // ================= 5.5 刷新后选择未加载消息的会话 =================
  // 回归：selector 返回新的空数组会让 zustand/React 进入无限重渲染。
  // 刷新后先选一个消息还没拉回来的会话，必须正常挂载而不是掉进错误边界。
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().userId === ${JSON.stringify(userId)}`,
    20_000,
    '刷新后身份'
  )
  await evalJs(
    `window.history.pushState({}, '', '/text'); window.dispatchEvent(new PopStateEvent('popstate')); true`
  )
  await sleep(1200)
  await evalJs(
    `window.__amadeus.sessionStore.getState().selectSession(${JSON.stringify(sessionA)})`
  )
  await waitFor(
    `!!document.querySelector('[data-testid="panel-tab-graph"]')`,
    10_000,
    '刷新后右侧面板'
  )
  const loopError = await evalJs(`document.body.innerText.includes('Maximum update depth')`)
  report('稳定性：刷新后选择未加载消息的会话不触发重渲染循环', !loopError)

  // ================= 6. 工件 =================
  await evalJs(`(() => {
    const store = window.__amadeus.sessionStore
    const state = store.getState()
    const id = ${JSON.stringify(sessionA)}
    const fixture = {
      id: 'wb-artifact-fixture',
      sessionId: id,
      role: 'assistant',
      content: '\\u0060\\u0060\\u0060html\\n<h1 id="wb-artifact">Workbench Artifact</h1>\\n\\u0060\\u0060\\u0060',
      ttsText: null,
      mode: 'text',
      createdAt: Date.now()
    }
    store.setState({ messages: { ...state.messages, [id]: [...(state.messages[id] ?? []), fixture] } })
    return true
  })()`)
  await evalJs(`document.querySelector('[data-testid="panel-tab-artifacts"]').click(); true`)
  await waitFor(`document.querySelectorAll('[data-testid="artifact-item"]').length >= 1`, 10_000, '工件列表')
  await evalJs(`document.querySelector('[data-testid="artifact-item"]').click(); true`)
  const srcDoc = await waitFor(
    `document.querySelector('[data-testid="artifact-frame"]')?.getAttribute('srcdoc') ?? ''`,
    10_000,
    '工件预览'
  )
  report('工件：列表提取并在沙箱 iframe 预览', String(srcDoc).includes('Workbench Artifact'))
  await evalJs(`document.querySelector('[data-testid="artifact-close"]')?.click(); true`)

  // ================= 7. 面板收起 / 展开 =================
  await evalJs(`document.querySelector('[data-testid="panel-collapse"]').click(); true`)
  await sleep(300)
  const collapsed = !(await evalJs(`!!document.querySelector('[data-testid="workbench-side-panel"]')`))
  await evalJs(`document.querySelector('[data-testid="toggle-side-panel"]').click(); true`)
  const reopened = await waitFor(
    `!!document.querySelector('[data-testid="workbench-side-panel"]')`,
    5_000,
    '展开面板'
  ).catch(() => false)
  report('面板：可收起并重新展开', collapsed && Boolean(reopened))
} catch (error) {
  console.error('E2E 异常：', error)
  report('脚本执行完成', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupOnce()
  cdp.close()
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
if (passed !== results.length) process.exitCode = 1
