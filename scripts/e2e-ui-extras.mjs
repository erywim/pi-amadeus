/**
 * 新能力的桌面端 UI E2E：
 *  1. 设置 → 陪伴：主动问候开关/空闲/时间窗/次数保存到服务端，立即问候显示真实生成结果
 *  2. 陪伴页：外部新问候到达后轮询自动切到会话并显示消息
 *  3. 自动化：Webhook 触发任务可在表单创建、立即运行并显示触发来源
 *  4. 模型服务：路由标签与每日配额在卡片上展示
 *
 * 前置：brain（3002）与桌面端 dev（CDP 默认 9222 / CDP_HTTP 覆盖）已启动，LLM 可用。
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
async function jsonApi(path, method, body) {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const origin = await evalJs('location.origin')
    if (typeof origin === 'string' && /^https?:/i.test(origin)) {
      await cdp.call('Page.navigate', { url: `${origin}${path}` })
      return
    }
    await sleep(300)
  }
  throw new Error(`导航失败：拿不到页面 origin（${path}）`)
}
const setText = (selector, value) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
const click = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`

const stamp = Date.now()
const username = `e2e-ui-x-${stamp}`
const providerName = `路由展示 ${stamp}`
const automationName = `Webhook UI ${stamp}`
let userId = ''
const createdSessions = []
const createdAutomations = []
const createdProviders = []

async function cleanup() {
  for (const id of createdAutomations) {
    await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
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
  const login = await jsonApi('/api/users/login', 'POST', { username })
  userId = login.body.userId
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().userId === ${JSON.stringify(userId)}`,
    20_000,
    '身份同步'
  )

  // ================= 1. 主动问候设置 =================
  console.log('[step] proactive settings')
  await navigate('/settings')
  await sleep(1500)
  await waitFor(`document.body.innerText.includes('陪伴')`, 20_000, '设置页')
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('nav button')].find((el) => el.textContent.trim() === '陪伴'); b?.click(); return !!b })()`
  )
  await waitFor(`!!document.querySelector('[data-testid="proactive-enabled"]')`, 10_000, '主动问候面板')
  await evalJs(click('[data-testid="proactive-enabled"]'))
  await evalJs(setText('[data-testid="proactive-min-idle"]', '5'))
  await evalJs(setText('[data-testid="proactive-start"]', '00:00'))
  await evalJs(setText('[data-testid="proactive-end"]', '23:59'))
  await evalJs(setText('[data-testid="proactive-max"]', '2'))
  await evalJs(click('[data-testid="proactive-save"]'))
  const saved = await waitFor(async () => {
    const response = await api(`/api/proactive?userId=${userId}`)
    return response.body.settings?.enabled === true &&
      response.body.settings?.minIdleMinutes === 5
      ? response.body.settings
      : null
  }, 15_000, '主动问候设置保存')
  report('主动问候 UI：设置保存到服务端', Boolean(saved), `idle=${saved?.minIdleMinutes}`)

  await evalJs(click('[data-testid="proactive-run"]'))
  const firstGreeting = await waitFor(
    `document.querySelector('[data-testid="proactive-latest"]')?.innerText ?? ''`,
    120_000,
    '立即问候结果'
  )
  report('主动问候 UI：立即生成并显示真实消息', String(firstGreeting).length > 3, String(firstGreeting).slice(0, 50))
  createdSessions.push(`proactive-${userId}`)

  // ================= 2. 陪伴页轮询新问候 =================
  console.log('[step] companion polling')
  await navigate('/companion')
  await sleep(2500)
  // 首次轮询会把已有问候记为已读，这里先等它完成
  await sleep(1500)
  const second = await jsonApi('/api/proactive/run', 'POST', { userId })
  const secondContent = second.body.greeting?.content ?? ''
  report('主动问候：外部生成第二条', secondContent.length > 3, secondContent.slice(0, 40))
  const arrived = await waitFor(
    `(() => {
      const s = window.__amadeus.sessionStore.getState();
      const id = s.activeSessionId;
      const messages = id ? (s.messages[id] ?? []) : [];
      return messages.some((m) => m.role === 'assistant' && m.content === ${JSON.stringify(secondContent)});
    })()`,
    45_000,
    '陪伴页收到主动问候'
  ).catch(() => false)
  report('主动问候 UI：陪伴页轮询后自动显示', Boolean(arrived))

  // ================= 3. 自动化 Webhook 表单 =================
  console.log('[step] automation form')
  await navigate('/automations')
  await sleep(1600)
  await waitFor(`!!document.querySelector('[data-testid="automation-new"]')`, 15_000, '自动化页')
  await evalJs(click('[data-testid="automation-new"]'))
  await waitFor(`!!document.querySelector('[data-testid="automation-name"]')`, 5_000, '任务表单')
  await evalJs(setText('[data-testid="automation-name"]', automationName))
  await evalJs(setText('[data-testid="automation-prompt"]', '只回复四个字：界面触发。不要调用工具。'))
  await evalJs(click('[data-testid="automation-trigger-webhook"]'))
  await evalJs(click('[data-testid="automation-save"]'))
  const created = await waitFor(async () => {
    const response = await api(`/api/automations?userId=${userId}`)
    return response.body.automations?.find((item) => item.name === automationName) ?? null
  }, 15_000, 'Webhook 任务创建')
  createdAutomations.push(created.id)
  report(
    '自动化 UI：创建 Webhook 任务',
    created.trigger === 'webhook' && String(created.webhookSecret).length >= 16
  )
  await waitFor(
    `[...document.querySelectorAll('[data-testid="automation-item"]')].some((el) => el.textContent.includes(${JSON.stringify(automationName)}))`,
    10_000,
    '任务卡片'
  )
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('[data-testid="automation-item"]')].find((el) => el.textContent.includes(${JSON.stringify(automationName)}))
    row?.querySelector('[data-testid="automation-run"]')?.click()
    return true
  })()`)
  const ran = await waitFor(
    `(() => {
      const item = window.__amadeus.automationStore.getState().items.find((x) => x.name === ${JSON.stringify(automationName)})
      return item && item.lastStatus === 'success' ? item : null
    })()`,
    180_000,
    'Webhook 任务运行'
  ).catch(() => null)
  report(
    '自动化 UI：立即运行并显示触发来源',
    Boolean(ran) && String(ran?.lastTrigger).includes('手动运行')
  )
  createdSessions.push(`automation-${created.id}`)

  // ================= 4. 模型服务标签与配额展示 =================
  console.log('[step] provider routing card')
  const envMap = readEnv(new URL('../services/brain/.env', import.meta.url))
  if (!envMap.LLM_API_KEY || !envMap.LLM_BASE_URL) {
    report('模型服务 UI：标签/配额（跳过：.env 无真实配置）', true, 'not run')
  } else {
    const provider = await jsonApi('/api/providers', 'POST', {
      name: providerName,
      baseUrl: envMap.LLM_BASE_URL,
      model: envMap.AI_MODEL || 'deepseek-v4-pro',
      apiKey: envMap.LLM_API_KEY,
      tags: ['vision'],
      dailyTokenQuota: 100_000,
      priority: 50
    })
    createdProviders.push(provider.body.provider?.id)
    await navigate('/settings')
    await sleep(1600)
    await waitFor(`document.body.innerText.includes('模型服务')`, 15_000, 'AI 设置')
    await waitFor(
      `!!document.querySelector('[data-provider-id="${provider.body.provider.id}"]')`,
      15_000,
      '服务卡片'
    )
    const rowText = await evalJs(
      `document.querySelector('[data-provider-id="${provider.body.provider.id}"]')?.innerText ?? ''`
    )
    report(
      '模型服务 UI：路由标签与每日配额可见',
      String(rowText).includes('视觉') && String(rowText).includes('100000'),
      String(rowText).replace(/\n/g, ' / ').slice(0, 80)
    )
  }
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
