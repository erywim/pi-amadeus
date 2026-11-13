/**
 * 新页面与聊天增强的桌面端 E2E（CDP 驱动真实 Electron 应用）：
 *  1. 知识库页：新建 → 粘贴导入 → 检索预览 → 删除文档
 *  2. 自动化页：新建任务 → 立即运行 → 状态变成功 → 展开结果
 *  3. 会话：置顶、正文搜索、编辑后重发、用量读数
 *  4. 工件预览：HTML iframe 与 Mermaid SVG（注入一条内存消息作为渲染夹具，不落库）
 *
 * 前置：brain（默认 3002）与桌面端 dev（CDP 默认 9222，可用 CDP_HTTP 覆盖）已启动，LLM 可用。
 * 测试自建用户与会话，结束统一清理。
 */
import { setTimeout as sleep } from 'node:timers/promises'

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
  // 页面导航/context 切换期间 Runtime.evaluate 可能被回收；这类错误发生时表达式
  // 尚未真正执行，重试是安全的（断言本身不依赖“恰好执行一次”）
  for (let attempt = 0; ; attempt += 1) {
    try {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transient = /Promise was collected|Cannot find context|Execution context was destroyed|Target closed/i.test(message)
      if (attempt < 2 && transient) {
        await sleep(200)
        continue
      }
      throw error
    }
  }
}
/** 用 CDP 导航而不是在页面里改 location：后者会在上下文销毁时把 evaluate 的 Promise 一起丢掉 */
async function navigate(path) {
  const origin = await evalJs('location.origin')
  await cdp.call('Page.navigate', { url: `${origin}${path}` })
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
const setInput = (selector, value) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
const click = (selector, index = 0) =>
  `(() => {
    const list = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = list[${index}]
    if (!el) return false
    el.click()
    return true
  })()`

/** 测试数据 */
const stamp = Date.now()
const username = `e2e-ui-${stamp}`
/** 登录后写入，清理阶段按归属删除知识库 */
let ownerUserId = ''
const kbName = `UI 知识库 ${stamp}`
const fact = `UI 星图密钥是 VIOLET-${String(stamp).slice(-4)}。`
const automationName = `UI 自动任务 ${stamp}`
const createdSessions = []
const createdBases = []
const createdAutomations = []
const createdProviders = []

async function cleanup() {
  for (const id of createdAutomations) {
    await api(`/api/automations/${id}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdBases) {
    await api(`/api/knowledge/${id}?userId=${encodeURIComponent(ownerUserId)}`, {
      method: 'DELETE'
    }).catch(() => {})
  }
  for (const id of createdSessions) {
    await api(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdProviders) {
    await api(`/api/providers/${id}`, { method: 'DELETE' }).catch(() => {})
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
  // 切换到这个脚本自己的身份：login 会写 current_user，随后整页刷新让 store 重新初始化
  const login = await api('/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
  const userId = login.body.userId
  ownerUserId = userId
  await navigate('/knowledge')
  await sleep(1800)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().initialized && window.__amadeus.sessionStore.getState().userId === ${JSON.stringify(userId)}`,
    20_000,
    '登录身份同步'
  )
  report('桌面端：测试身份就绪', true, username)

  // ================= 知识库页 =================
  await waitFor(`!!document.querySelector('[data-testid="kb-new"]')`, 15_000, '知识库页')
  await evalJs(click('[data-testid="kb-new"]'))
  await waitFor(`!!document.querySelector('[data-testid="kb-name"]')`, 5_000, '新建表单')
  await evalJs(setInput('[data-testid="kb-name"]', kbName))
  await evalJs(click('[data-testid="kb-create"]'))
  await waitFor(
    `[...document.querySelectorAll('[data-testid="kb-item"]')].some(el => el.textContent.includes(${JSON.stringify(kbName)}))`,
    15_000,
    '知识库创建'
  )
  let list = await api(`/api/knowledge?userId=${userId}`)
  const base = list.body.bases?.find((item) => item.name === kbName)
  if (base) createdBases.push(base.id)
  report('知识库页：新建知识库', Boolean(base))

  await evalJs(click('[data-testid="kb-import-text"]'))
  await waitFor(`!!document.querySelector('[data-testid="kb-doc-content"]')`, 5_000, '粘贴表单')
  await evalJs(setInput('[data-testid="kb-doc-content"]', `${fact}\n\n这是桌面端导入的测试资料。`))
  await evalJs(click('[data-testid="kb-doc-import"]'))
  await waitFor(`document.querySelectorAll('[data-testid="kb-doc"]').length >= 1`, 15_000, '文档导入')
  report('知识库页：粘贴导入文档', true)

  await evalJs(setInput('[data-testid="kb-search"]', '星图密钥'))
  const hitText = await waitFor(
    `(() => { const el = document.querySelector('[data-testid="kb-hit"]'); return el ? el.textContent : '' })()`,
    15_000,
    '检索命中'
  )
  report('知识库页：检索预览显示原文', String(hitText).includes('VIOLET-'), String(hitText).slice(0, 60))

  await evalJs(click('[data-testid="kb-doc"] button'))
  await waitFor(`document.querySelectorAll('[data-testid="kb-doc"]').length === 0`, 10_000, '删除文档')
  report('知识库页：删除文档', true)
  await evalJs(setInput('[data-testid="kb-search"]', ''))

  // ================= 自动化页 =================
  await navigate('/automations')
  await sleep(1600)
  await waitFor(`!!document.querySelector('[data-testid="automation-new"]')`, 15_000, '自动化页')
  await evalJs(click('[data-testid="automation-new"]'))
  await waitFor(`!!document.querySelector('[data-testid="automation-name"]')`, 5_000, '任务表单')
  await evalJs(setInput('[data-testid="automation-name"]', automationName))
  await evalJs(setInput('[data-testid="automation-prompt"]', '只回复四个字：界面完成。不要调用任何工具。'))
  await evalJs(click('[data-testid="automation-schedule-interval"]'))
  await evalJs(setInput('[data-testid="automation-interval"]', '45'))
  await evalJs(click('[data-testid="automation-save"]'))
  await waitFor(
    `[...document.querySelectorAll('[data-testid="automation-item"]')].some(el => el.textContent.includes(${JSON.stringify(automationName)}))`,
    15_000,
    '任务创建'
  )
  list = await api(`/api/automations?userId=${userId}`)
  const automation = list.body.automations?.find((item) => item.name === automationName)
  if (automation) createdAutomations.push(automation.id)
  report(
    '自动化页：新建任务并写入下次触发时间',
    Boolean(automation) && typeof automation.nextRunAt === 'number',
    automation?.nextRunAt ? new Date(automation.nextRunAt).toLocaleTimeString() : ''
  )

  await evalJs(`(() => {
    const row = [...document.querySelectorAll('[data-testid="automation-item"]')].find(el => el.textContent.includes(${JSON.stringify(automationName)}))
    row?.querySelector('[data-testid="automation-run"]').click()
    return true
  })()`)
  const finished = await waitFor(
    `(() => {
      const item = window.__amadeus.automationStore.getState().items.find(x => x.name === ${JSON.stringify(automationName)})
      return item && (item.lastStatus === 'success' || item.lastStatus === 'error') ? item.lastStatus : ''
    })()`,
    150_000,
    '任务运行结束'
  )
  report('自动化页：立即运行并完成', finished === 'success', String(finished))

  await waitFor(
    `(() => {
      const row = [...document.querySelectorAll('[data-testid="automation-item"]')].find(el => el.textContent.includes(${JSON.stringify(automationName)}))
      return row ? !!row.querySelector('[data-testid="automation-view-result"]') : false
    })()`,
    15_000,
    '结果入口'
  )
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('[data-testid="automation-item"]')].find(el => el.textContent.includes(${JSON.stringify(automationName)}))
    row?.querySelector('[data-testid="automation-view-result"]').click()
    return true
  })()`)
  const resultText = await waitFor(
    `(() => { const el = document.querySelector('[data-testid="automation-result"]'); return el ? el.textContent.trim() : '' })()`,
    10_000,
    '结果展开'
  )
  report(
    '自动化页：展开显示真实运行结果',
    String(resultText).length > 0 && String(resultText).includes('界面完成'),
    String(resultText).slice(0, 50)
  )

  // ================= 通讯平台表单 =================
  // 先建一个不可达的模型服务并让它失败一次，验证设置页的「故障冷却」徽标
  const badProvider = await api('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `UI 冷却服务 ${stamp}`,
      baseUrl: 'http://127.0.0.1:9',
      model: 'bad-model',
      apiKey: 'x',
      priority: 99
    })
  })
  const badProviderId = badProvider.body.provider?.id
  if (badProviderId) createdProviders.push(badProviderId)
  await api(`/api/providers/${badProviderId}/test`, { method: 'POST' })

  await navigate('/settings')
  await sleep(1600)
  await waitFor(`document.body.innerText.includes('通讯平台')`, 20_000, '设置页')
  // load() 在已加载时会直接返回：先清 loaded 再拉一次，确保拿到冷却状态
  await evalJs(
    `(() => { const store = window.__amadeus.providerStore; store.setState({ loaded: false }); return store.getState().load() })()`
  )
  await waitFor(
    `!!document.querySelector('[data-provider-id="${badProviderId}"] [data-testid="provider-cooling"]')`,
    15_000,
    '故障冷却徽标'
  )
  report('模型服务：失败后设置页显示故障冷却', true)
  await api(`/api/providers/${badProviderId}`, { method: 'DELETE' })
  createdProviders.splice(createdProviders.indexOf(badProviderId), 1)
  await evalJs(
    `(() => { const button = [...document.querySelectorAll('nav button')].find((el) => el.textContent.includes('通讯平台')); button?.click(); return !!button })()`
  )
  await waitFor(`!!document.querySelector('[data-testid="platform-add"]')`, 10_000, '通讯平台面板')
  await evalJs(click('[data-testid="platform-add"]'))
  await waitFor(`!!document.querySelector('[data-testid="platform-kind-discord"]')`, 5_000, '新增弹窗')
  await evalJs(click('[data-testid="platform-kind-discord"]'))
  const discordFields = await evalJs(`(() => ({
    token: !!document.querySelector('[data-testid="platform-discord-token"]'),
    gateway: !!document.querySelector('[data-testid="platform-discord-gateway"]'),
    api: !!document.querySelector('[data-testid="platform-discord-api"]')
  }))()`)
  report(
    '通讯平台：Discord 表单字段齐全',
    discordFields.token && discordFields.gateway && discordFields.api,
    JSON.stringify(discordFields)
  )
  await evalJs(click('[data-testid="platform-kind-slack"]'))
  const slackFields = await evalJs(`(() => ({
    bot: !!document.querySelector('[data-testid="platform-slack-bot-token"]'),
    app: !!document.querySelector('[data-testid="platform-slack-app-token"]'),
    api: !!document.querySelector('[data-testid="platform-slack-api"]')
  }))()`)
  report(
    '通讯平台：Slack 表单字段齐全',
    slackFields.bot && slackFields.app && slackFields.api,
    JSON.stringify(slackFields)
  )
  await evalJs(
    `(() => { const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '取消'); button?.click(); return true })()`
  )

  // ================= 聊天增强 =================
  await navigate('/text')
  await sleep(1600)
  await waitFor(`!!window.__amadeus?.sessionStore.getState().userId`, 20_000, '文本模式')
  const sessionId = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessions.push(sessionId)

  // 置顶
  await evalJs(`window.__amadeus.sessionStore.getState().togglePin(${JSON.stringify(sessionId)})`)
  await waitFor(
    `window.__amadeus.sessionStore.getState().sessions.find(x => x.id === ${JSON.stringify(sessionId)})?.pinned === true`,
    10_000,
    '置顶'
  )
  const serverPinned = await api(`/api/sessions?userId=${userId}`)
  report(
    '聊天：置顶同步到服务端',
    serverPinned.body.sessions?.find((item) => item.id === sessionId)?.pinned === true
  )

  // 发一条消息，等真实回复
  await evalJs(`window.__amadeus.sessionStore.getState().sendMessage('只回复：第一版')`)
  await waitFor(
    `(() => {
      const s = window.__amadeus.sessionStore.getState()
      return !s.stream.streaming && (s.messages[${JSON.stringify(sessionId)}] ?? []).some(m => m.role === 'assistant')
    })()`,
    120_000,
    '首条回复'
  )
  report('聊天：真实回合完成', true)

  // 正文搜索
  await evalJs(setInput('[data-testid="session-search"]', '第一版'))
  const searchHit = await waitFor(
    `(() => { const el = document.querySelector('[data-testid="message-hit"]'); return el ? el.textContent : '' })()`,
    15_000,
    '消息搜索'
  )
  report('聊天：侧栏正文搜索命中', String(searchHit).includes('第一版'))
  await evalJs(setInput('[data-testid="session-search"]', ''))

  // 用量读数（标题栏）
  await waitFor(
    `(() => { const el = document.querySelector('[data-testid="session-usage"]'); return el ? el.textContent : '' })()`,
    15_000,
    '用量读数'
  )
  report('聊天：标题栏显示真实 token 用量', true)

  // 编辑后重发
  await evalJs(click('[data-testid="edit-message"]'))
  await waitFor(`!!document.querySelector('[data-testid="edit-message-input"]')`, 5_000, '编辑框')
  await evalJs(setInput('[data-testid="edit-message-input"]', '只回复：第二版'))
  await evalJs(click('[data-testid="edit-message-save"]'))
  await waitFor(
    `(() => {
      const s = window.__amadeus.sessionStore.getState()
      const messages = s.messages[${JSON.stringify(sessionId)}] ?? []
      return !s.stream.streaming && messages.length === 2 &&
        messages[0].content === '只回复：第二版' && messages[1].role === 'assistant'
    })()`,
    120_000,
    '编辑后重发'
  )
  const afterEdit = await api(`/api/sessions/${sessionId}/messages`)
  report(
    '聊天：编辑后重发并截断旧分支',
    afterEdit.body.messages?.length === 2 && afterEdit.body.messages[0].content === '只回复：第二版'
  )

  // ================= 工件预览 =================
  await evalJs(`(() => {
    const store = window.__amadeus.sessionStore
    const state = store.getState()
    const id = ${JSON.stringify(sessionId)}
    const fixture = {
      id: 'artifact-fixture-html',
      sessionId: id,
      role: 'assistant',
      content: '\\u0060\\u0060\\u0060html\\n<h1 id="hello">Hello Artifact</h1><p style="color:#2ea043">ok</p>\\n\\u0060\\u0060\\u0060',
      ttsText: null,
      mode: 'text',
      createdAt: Date.now()
    }
    store.setState({ messages: { ...state.messages, [id]: [...(state.messages[id] ?? []), fixture] } })
    return true
  })()`)
  await waitFor(
    `[...document.querySelectorAll('[data-testid="preview-artifact"]')].length > 0`,
    10_000,
    '预览入口'
  )
  // 最后一个预览按钮对应刚注入的 HTML 块
  await evalJs(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="preview-artifact"]')]
    buttons[buttons.length - 1].click()
    return true
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="artifact-panel"]')`, 10_000, '工件面板')
  const srcDoc = await evalJs(
    `document.querySelector('[data-testid="artifact-frame"]')?.getAttribute('srcdoc') ?? ''`
  )
  report('工件：HTML 在沙箱 iframe 中预览', String(srcDoc).includes('Hello Artifact'))
  await evalJs(click('[data-testid="artifact-close"]'))

  // Mermaid
  await evalJs(`(() => {
    const store = window.__amadeus.sessionStore
    const state = store.getState()
    const id = ${JSON.stringify(sessionId)}
    const fixture = {
      id: 'artifact-fixture-mermaid',
      sessionId: id,
      role: 'assistant',
      content: '\\u0060\\u0060\\u0060mermaid\\ngraph TD\\n  A[开始] --> B{判断}\\n  B -->|是| C[完成]\\n\\u0060\\u0060\\u0060',
      ttsText: null,
      mode: 'text',
      createdAt: Date.now() + 1
    }
    store.setState({ messages: { ...state.messages, [id]: [...(state.messages[id] ?? []), fixture] } })
    return true
  })()`)
  await waitFor(
    `[...document.querySelectorAll('[data-testid="preview-artifact"]')].length > 0`,
    10_000,
    'mermaid 预览入口'
  )
  await evalJs(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="preview-artifact"]')]
    buttons[buttons.length - 1].click()
    return true
  })()`)
  const svg = await waitFor(
    `(() => {
      const el = document.querySelector('[data-testid="artifact-mermaid"]')
      return el && el.querySelector('svg') ? el.innerHTML.slice(0, 80) : ''
    })()`,
    20_000,
    'mermaid 渲染'
  )
  report('工件：Mermaid 渲染成 SVG', String(svg).includes('<svg'))
} catch (error) {
  console.error('E2E 异常：', error)
  report('脚本执行完成', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupOnce()
  // CDP 的 WebSocket 会保持事件循环：不关掉脚本会挂在这里不退出
  cdp.close()
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
if (passed !== results.length) process.exitCode = 1
