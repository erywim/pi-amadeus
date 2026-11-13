/**
 * 模型运行参数 E2E（CDP 驱动真实 Electron + 真实 brain + 真实模型）：
 *  1. 模型服务表单里能配置「思考模式 / 上下文窗口 / 输出上限」，保存后服务端一致
 *  2. 内置 AI 配置里同样有三项，保存后 /api/config 一致
 *  3. 思考模式开启时真实回合产出思考流，并渲染折叠区、落库带 thinking
 *  4. 思考模式关闭时不展示、不落库（部分端点即使没请求也会回 reasoning_content）
 *  5. 输出上限真的下发：极小上限会让回合明确报「被截断」，而不是静默给半截内容
 *
 * 前置：brain（默认 3002）与桌面端 dev（CDP 默认 9222，可用 CDP_HTTP 覆盖）已启动，LLM 可用。
 * 脚本自建用户/服务/会话，结束统一清理；不写用户真实数据目录。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const LLM_BASE_URL = process.env.E2E_LLM_BASE_URL ?? process.env.LLM_BASE_URL ?? ''
const LLM_MODEL = process.env.E2E_LLM_MODEL ?? process.env.AI_MODEL ?? ''
const LLM_API_KEY = process.env.E2E_LLM_API_KEY ?? process.env.LLM_API_KEY ?? ''
/** 上游对档位支持不一；用广泛支持的 high 验证「开启」路径 */
const THINKING_LEVEL = process.env.E2E_THINKING_LEVEL ?? 'high'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
if (!target) {
  console.error('未找到 Electron 页面目标。确认桌面端 dev 已启动（9222 调试端口）。')
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
  ws.onerror = (e) => reject(new Error(`CDP 失败: ${e.message}`))
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const { resP, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(msg.error.message))
      else resP(msg.result)
    }
  }
})
async function evalJs(expression) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await cdp.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.exceptionDetails) {
        throw new Error(
          `页面脚本异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`
        )
      }
      return r.result.value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        attempt < 2 &&
        /Promise was collected|Cannot find context|Execution context was destroyed/i.test(message)
      ) {
        await sleep(200)
        continue
      }
      throw error
    }
  }
}
async function waitFor(expression, timeoutMs = 30_000, label = typeof expression === 'string' ? expression : 'condition') {
  const start = Date.now()
  for (;;) {
    const value = typeof expression === 'function' ? await expression() : await evalJs(expression)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(200)
  }
}
async function navigate(path) {
  const origin = await evalJs('location.origin')
  await cdp.call('Page.navigate', { url: `${origin}${path}` })
}
const click = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`
const setText = (selector, value) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing'
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`

async function api(path, options) {
  const res = await fetch(`${BRAIN}${path}`, options)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
const jsonApi = (path, method, payload) =>
  api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  })

const createdProviders = []
const createdSessions = []
let userId = ''
async function cleanup() {
  for (const id of createdProviders) {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdSessions) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
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
  if (!LLM_BASE_URL || !LLM_MODEL) {
    console.error('缺少 E2E_LLM_BASE_URL / E2E_LLM_MODEL（或 brain 的 LLM_BASE_URL / AI_MODEL）。')
    process.exit(1)
  }
  const username = `e2e-runtime-${Date.now()}`
  const login = await jsonApi('/api/users/login', 'POST', { username })
  userId = login.body.userId
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().userId === ${JSON.stringify(userId)}`,
    20_000,
    '身份同步'
  )

  // ================= 1. 服务表单：三项可配置并落到服务端 =================
  console.log('[step] provider runtime form')
  await navigate('/settings')
  await sleep(1500)
  await waitFor(`!!document.querySelector('[data-testid="provider-add"]')`, 20_000, '设置页')
  await evalJs(click('[data-testid="provider-add"]'))
  await waitFor(`!!document.querySelector('[data-testid="provider-name"]')`, 10_000, '新增弹窗')
  await evalJs(setText('[data-testid="provider-name"]', `运行参数 ${Date.now()}`))
  await evalJs(setText('[data-testid="provider-base-url"]', LLM_BASE_URL))
  await evalJs(setText('[data-testid="provider-api-key"]', LLM_API_KEY))
  await evalJs(setText('[data-testid="provider-model"]', LLM_MODEL))
  await evalJs(setText('[data-testid="provider-context-window"]', '64000'))
  await evalJs(setText('[data-testid="provider-max-tokens"]', '3072'))
  // Radix Select：点开 → 选 high
  await evalJs(click('[data-testid="provider-thinking-level"]'))
  await waitFor(`!!document.querySelector('[role="option"]')`, 8000, '档位菜单')
  await evalJs(
    `(() => {
       const items = [...document.querySelectorAll('[role="option"]')]
       const target = items.find((el) => el.textContent.trim() === '高' || el.textContent.trim() === 'High')
       if (!target) return 'no-high'
       target.click()
       return 'clicked'
     })()`
  )
  await evalJs(click('[data-testid="provider-save"]'))
  const provider = await waitFor(async () => {
    const list = await api('/api/providers')
    return list.body.providers.find((p) => p.name.startsWith('运行参数')) ?? null
  }, 15_000, '服务保存')
  createdProviders.push(provider.id)
  report(
    '服务表单：思考档位 / 上下文窗口 / 输出上限保存到服务端',
    provider.thinkingLevel === THINKING_LEVEL &&
      provider.contextWindow === 64_000 &&
      provider.maxTokens === 3_072,
    `level=${provider.thinkingLevel} window=${provider.contextWindow} max=${provider.maxTokens}`
  )

  // ================= 2. 内置配置三项一致 =================
  console.log('[step] builtin runtime form')
  await evalJs(setText('[data-testid="ai-context-window"]', '32000'))
  await evalJs(setText('[data-testid="ai-max-tokens"]', '2048'))
  const saveBuiltin = await evalJs(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('保存更改')); if(!b) return false; b.click(); return true })()`
  )
  await sleep(1500)
  const config = await api(`/api/config/${userId}`)
  report(
    '内置配置：窗口 / 上限保存到服务端',
    Boolean(saveBuiltin) &&
      config.body.config.provider.contextWindow === 32_000 &&
      config.body.config.provider.maxTokens === 2_048,
    `window=${config.body.config.provider.contextWindow} max=${config.body.config.provider.maxTokens}`
  )

  // ================= 3. 开启思考：真实回合产出思考并上屏 =================
  console.log('[step] thinking on')
  await api(`/api/providers/${provider.id}/active`, { method: 'PUT' })
  await navigate('/text')
  await sleep(2000)
  await waitFor(`window.__amadeus?.sessionStore.getState().initialized`, 20_000, 'store')
  const sid = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessions.push(sid)
  await sleep(1000)
  await evalJs(
    `(() => {
       const el = document.querySelector('textarea')
       if (!el) return false
       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '一个班 40 人，60% 是女生，女生里 25% 戴眼镜。戴眼镜的女生有多少人？先想清楚再只给最终数字。')
       el.dispatchEvent(new Event('input', { bubbles: true }))
       el.focus()
       el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
       return true
     })()`
  )
  const thinkingShown = await waitFor(
    `!!document.querySelector('[data-testid="thinking-block"]')`,
    90_000,
    '思考折叠区'
  ).catch(() => false)
  await waitFor(`!window.__amadeus.sessionStore.getState().stream.streaming`, 120_000, '回合结束')
  const onTurn = await evalJs(`(() => {
    const list = window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}] ?? []
    const last = list.at(-1)
    return {
      content: last?.content ?? '',
      thinkingLen: last?.thinking?.length ?? 0,
      blocks: document.querySelectorAll('[data-testid="thinking-block"]').length
    }
  })()`)
  report('思考开启：回合渲染思考折叠区', Boolean(thinkingShown) && onTurn.blocks > 0, `blocks=${onTurn.blocks}`)
  report(
    '思考开启：正文与落库的思考内容都真实存在',
    onTurn.content.length > 0 && onTurn.thinkingLen > 0,
    `content=${onTurn.content.slice(0, 20)} thinking=${onTurn.thinkingLen}`
  )
  const serverMessages = await api(`/api/sessions/${sid}/messages`)
  const serverAssistant = serverMessages.body.messages.filter((m) => m.role === 'assistant').at(-1)
  report(
    '思考开启：服务端消息带 thinking 字段',
    (serverAssistant?.thinking?.length ?? 0) > 0,
    `len=${serverAssistant?.thinking?.length ?? 0}`
  )

  // 历史刷新后思考仍在（来自落库，不是内存残留）
  await navigate('/text')
  await sleep(2500)
  await waitFor(`window.__amadeus?.sessionStore.getState().initialized`, 20_000, 'store 重载')
  await evalJs(`window.__amadeus.sessionStore.getState().selectSession(${JSON.stringify(sid)})`)
  const reloaded = await waitFor(
    `document.querySelectorAll('[data-testid="thinking-block"]').length > 0`,
    15_000,
    '刷新后思考折叠区'
  ).catch(() => false)
  report('思考开启：刷新后从服务端重新渲染思考', Boolean(reloaded))

  // ================= 4. 关闭思考：不展示、不落库 =================
  console.log('[step] thinking off')
  await jsonApi(`/api/providers/${provider.id}`, 'PATCH', {
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    thinkingLevel: 'off',
    contextWindow: 64_000,
    maxTokens: 3_072
  })
  const offSession = `${sid}-off`
  createdSessions.push(offSession)
  const offRun = await fetch(`${BRAIN}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionId: offSession, content: '只回复：好' })
  })
  const offText = await offRun.text()
  const offEvents = offText
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const offThinking = offEvents.filter((e) => e.type === 'thinking').length
  const offContent = offEvents.filter((e) => e.type === 'delta').map((e) => e.delta).join('')
  report(
    '思考关闭：不转发思考事件、正文正常',
    offThinking === 0 && offContent.length > 0,
    `thinkingEvents=${offThinking} content=${offContent.slice(0, 12)}`
  )
  const offMessages = await api(`/api/sessions/${offSession}/messages`)
  const offAssistant = offMessages.body.messages.filter((m) => m.role === 'assistant').at(-1)
  report('思考关闭：服务端不落 thinking', !offAssistant?.thinking, `thinking=${offAssistant?.thinking ?? 'none'}`)

  // ================= 5. 输出上限真的下发 =================
  console.log('[step] max tokens enforcement')
  await jsonApi(`/api/providers/${provider.id}`, 'PATCH', {
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    thinkingLevel: 'off',
    contextWindow: 128_000,
    maxTokens: 8
  })
  const tinySession = `${sid}-tiny`
  createdSessions.push(tinySession)
  const tinyRes = await fetch(`${BRAIN}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionId: tinySession, content: '用中文写一段三百字的散文，主题雨夜。' })
  })
  const tinyText = await tinyRes.text()
  const tinyEvents = tinyText
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const tinyError = tinyEvents.find((e) => e.type === 'error')?.message ?? ''
  const tinyContent = tinyEvents.filter((e) => e.type === 'delta').map((e) => e.delta).join('')
  report(
    '输出上限：极小上限被真实执行并给出可操作报错',
    tinyContent.length < 120 && /输出上限|截断/.test(tinyError),
    `contentLen=${tinyContent.length} error=${tinyError.slice(0, 40)}`
  )
} finally {
  await cleanupOnce()
}

const failed = results.filter((r) => !r.ok && !r.skipped)
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`)
cdp.close()
process.exit(failed.length > 0 ? 1 : 0)
