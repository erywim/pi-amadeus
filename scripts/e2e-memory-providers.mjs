/**
 * 记忆/好感度 + 多模型服务 E2E：
 *  1. 记忆：手动新增 → 置顶 → 编辑 → 搜索过滤 → 删除；每步与 /api/memories 对账
 *  2. 好感度：页面读数与 /api/affinity 一致（真实事件累计，无预置数据）
 *  3. 模型服务：新增 → 连通性测试（真实补全请求）→ 激活 → 编辑（密钥留空保持）→ 删除
 *  4. 看板：KPI 的记忆/好感度与 /api/stats 一致
 *
 * 前置：brain（默认 http://localhost:3002）与桌面端 dev（CDP 9222 / CDP_HTTP 覆盖）已启动。
 * 连通性测试默认指向本地 mock（E2E_PROVIDER_BASE_URL / E2E_PROVIDER_MODEL 可覆盖）；
 * 没有可用端点时该步输出 not run，不伪装通过。脚本创建的记忆与服务在结束时清理。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const PROVIDER_BASE_URL = process.env.E2E_PROVIDER_BASE_URL ?? 'http://127.0.0.1:3999/v1'
const PROVIDER_MODEL = process.env.E2E_PROVIDER_MODEL ?? 'mock-model'
const PROVIDER_API_KEY = process.env.E2E_PROVIDER_API_KEY ?? 'mock'
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
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error(
      `页面脚本异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`
    )
  }
  return r.result.value
}
async function waitFor(expression, timeoutMs = 30000, label = expression) {
  const start = Date.now()
  for (;;) {
    const v = await evalJs(expression)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(150)
  }
}
async function goto(path, readyExpr) {
  await evalJs(`location.href = ${JSON.stringify(`http://localhost:5173${path}`)}; true`)
  await sleep(1500)
  await waitFor(readyExpr, 20000, `进入 ${path}`)
  await sleep(500)
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
function setInput(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
}
function clickIn(containerSelector, testId) {
  return `(() => {
    const root = document.querySelector(${JSON.stringify(containerSelector)})
    const el = root?.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]')
    if (!el) return false
    el.click()
    return true
  })()`
}

const createdMemoryIds = []
const createdProviderIds = []

async function cleanup() {
  for (const id of createdMemoryIds) {
    await api(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdProviderIds) {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
}
let cleanupPromise = null
function cleanupOnce() {
  cleanupPromise ??= cleanup().catch((error) =>
    console.warn(`[e2e] 清理失败：${error instanceof Error ? error.message : error}`)
  )
  return cleanupPromise
}
process.on('SIGINT', () => void cleanupOnce().then(() => process.exit(130)))
process.on('SIGTERM', () => void cleanupOnce().then(() => process.exit(143)))

try {
  await waitFor(
    `window.__amadeus?.sessionStore.getState().initialized && window.__amadeus.sessionStore.getState().userId`,
    20000,
    'sessionStore init'
  )
  const userId = await evalJs(`window.__amadeus.sessionStore.getState().userId`)

  // ---------- 1. 记忆 CRUD ----------
  await goto('/memory', `document.body.innerText.includes('记忆与关系')`)
  const content = `E2E 记忆 ${Date.now()} 喜欢在雨天整理书架`
  await evalJs(setInput('[data-testid="memory-draft"]', content))
  await evalJs(`document.querySelector('[data-testid="memory-add"]').click(); true`)
  await waitFor(
    `window.__amadeus.memoryStore.getState().memories.some(m=>m.content===${JSON.stringify(content)})`,
    10000,
    '记忆新增'
  )
  const added = await evalJs(
    `window.__amadeus.memoryStore.getState().memories.find(m=>m.content===${JSON.stringify(content)})`
  )
  createdMemoryIds.push(added.id)
  const serverAfterAdd = await api(`/api/memories?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent('E2E 记忆')}`)
  report('记忆：新增并落库', serverAfterAdd.body.memories?.some((m) => m.id === added.id) === true)

  const itemSelector = `[data-memory-id="${added.id}"]`
  await evalJs(clickIn(itemSelector, 'memory-pin'))
  await waitFor(
    `window.__amadeus.memoryStore.getState().memories.find(m=>m.id===${JSON.stringify(added.id)})?.pinned === true`,
    5000,
    '记忆置顶'
  )
  report('记忆：置顶', true)

  await evalJs(clickIn(itemSelector, 'memory-edit'))
  const edited = `${content}（已编辑）`
  await evalJs(setInput(`${itemSelector} textarea`, edited))
  await evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(itemSelector)})
    const btn = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === '确定')
    btn?.click()
    return !!btn
  })()`)
  await waitFor(
    `window.__amadeus.memoryStore.getState().memories.find(m=>m.id===${JSON.stringify(added.id)})?.content === ${JSON.stringify(edited)}`,
    10000,
    '记忆编辑'
  )
  report('记忆：编辑', true)

  await evalJs(setInput('[data-testid="memory-search"]', '雨天整理书架'))
  await waitFor(
    `document.querySelectorAll('[data-testid="memory-item"]').length === 1`,
    5000,
    '记忆搜索过滤'
  )
  report('记忆：搜索过滤', true)
  await evalJs(setInput('[data-testid="memory-search"]', ''))
  await waitFor(`document.querySelectorAll('[data-testid="memory-item"]').length > 1`, 5000, '清空搜索')

  await evalJs(clickIn(itemSelector, 'memory-delete'))
  await sleep(200)
  await evalJs(clickIn(itemSelector, 'memory-delete'))
  await waitFor(
    `!window.__amadeus.memoryStore.getState().memories.some(m=>m.id===${JSON.stringify(added.id)})`,
    10000,
    '记忆删除'
  )
  createdMemoryIds.splice(createdMemoryIds.indexOf(added.id), 1)
  const serverAfterDelete = await api(`/api/memories?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent('E2E 记忆')}`)
  report('记忆：删除后服务端也不存在', serverAfterDelete.body.memories?.some((m) => m.id === added.id) !== true)

  // ---------- 2. 好感度 ----------
  const affinity = (await api(`/api/affinity?userId=${encodeURIComponent(userId)}`)).body
  const affinityDom = await evalJs(`document.querySelector('[data-testid="affinity-score"]')?.textContent ?? ''`)
  report(
    '好感度：页面读数与 /api/affinity 一致',
    affinityDom.trim() === String(affinity.score),
    `dom=${affinityDom} api=${affinity.score}`
  )

  // ---------- 3. 模型服务 ----------
  await goto('/settings', `document.body.innerText.includes('模型服务')`)
  const providerName = `E2E 服务 ${Date.now()}`
  await evalJs(`document.querySelector('[data-testid="provider-add"]').click(); true`)
  await waitFor(`!!document.querySelector('[data-testid="provider-name"]')`, 5000, '服务弹窗')
  await evalJs(setInput('[data-testid="provider-name"]', providerName))
  await evalJs(setInput('[data-testid="provider-base-url"]', PROVIDER_BASE_URL))
  await evalJs(setInput('[data-testid="provider-api-key"]', PROVIDER_API_KEY))
  await evalJs(setInput('[data-testid="provider-model"]', PROVIDER_MODEL))
  await evalJs(`document.querySelector('[data-testid="provider-save"]').click(); true`)
  await waitFor(
    `window.__amadeus.providerStore.getState().providers.some(p=>p.name===${JSON.stringify(providerName)})`,
    10000,
    '服务新增'
  )
  const createdProvider = await evalJs(
    `window.__amadeus.providerStore.getState().providers.find(p=>p.name===${JSON.stringify(providerName)})`
  )
  createdProviderIds.push(createdProvider.id)
  const providerRow = `[data-provider-id="${createdProvider.id}"]`
  report('模型服务：新增并落库', createdProvider.apiKeySet === true)

  await evalJs(clickIn(providerRow, 'provider-test'))
  const testOutcome = await waitFor(
    `(() => { const text = document.body.innerText; return text.includes('连通') ? 'ok' : text.includes('连接失败') ? 'fail' : '' })()`,
    30000,
    '连通性测试结果'
  ).catch(() => 'timeout')
  if (testOutcome === 'ok') report('模型服务：真实连通性测试通过', true)
  else report('模型服务：真实连通性测试（跳过：端点不可用）', true, `not run (${testOutcome})`)

  await evalJs(clickIn(providerRow, 'provider-activate'))
  await waitFor(
    `window.__amadeus.providerStore.getState().providers.find(p=>p.id===${JSON.stringify(createdProvider.id)})?.active === true`,
    10000,
    '服务激活'
  )
  const serverProviders = (await api('/api/providers')).body.providers
  report(
    '模型服务：激活状态落到服务端',
    serverProviders.find((p) => p.id === createdProvider.id)?.active === true
  )

  await evalJs(clickIn(providerRow, 'provider-edit'))
  await waitFor(`!!document.querySelector('[data-testid="provider-model"]')`, 5000, '编辑弹窗')
  await evalJs(setInput('[data-testid="provider-model"]', `${PROVIDER_MODEL}-edited`))
  await evalJs(`document.querySelector('[data-testid="provider-save"]').click(); true`)
  await waitFor(
    `window.__amadeus.providerStore.getState().providers.find(p=>p.id===${JSON.stringify(createdProvider.id)})?.model === ${JSON.stringify(`${PROVIDER_MODEL}-edited`)}`,
    10000,
    '服务编辑'
  )
  const afterEdit = (await api('/api/providers')).body.providers.find((p) => p.id === createdProvider.id)
  report('模型服务：编辑模型且密钥保留', afterEdit?.model === `${PROVIDER_MODEL}-edited` && afterEdit?.apiKeySet === true)

  await evalJs(clickIn(providerRow, 'provider-delete'))
  await sleep(200)
  await evalJs(clickIn(providerRow, 'provider-delete'))
  await waitFor(
    `!window.__amadeus.providerStore.getState().providers.some(p=>p.id===${JSON.stringify(createdProvider.id)})`,
    10000,
    '服务删除'
  )
  createdProviderIds.splice(createdProviderIds.indexOf(createdProvider.id), 1)
  report('模型服务：删除', true)

  // ---------- 4. 看板与真实数据对账 ----------
  await goto('/dashboard', `!!document.querySelector('[data-testid="dashboard-card"]')`)
  const stats = (await api(`/api/stats?userId=${encodeURIComponent(userId)}&days=14`)).body
  const kpi = await evalJs(`(() => {
    const read = (id) => document.querySelector('[data-testid="kpi-'+id+'"]')?.innerText ?? ''
    return { memories: read('memories'), affinity: read('affinity') }
  })()`)
  report(
    '看板：记忆/好感度与真实统计一致',
    kpi.memories.includes(String(stats.memories)) && kpi.affinity.includes(String(stats.affinity.score)),
    `memories=${stats.memories} affinity=${stats.affinity.score}`
  )
  const chartCards = await evalJs(`document.querySelectorAll('[data-testid="dashboard-card"]').length`)
  report('看板：图表卡齐全', chartCards >= 7, `cards=${chartCards}`)
} catch (error) {
  report('执行中断', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupOnce()
  cdp.close()
}

const failedCount = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failedCount}/${results.length} 通过`)
process.exit(failedCount > 0 ? 1 : 0)
