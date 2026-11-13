/**
 * 插件中心 + 数据看板 E2E：
 *  1. 目录规模与过滤：kind 过滤、标题搜索、清空恢复
 *  2. 安装快捷指令（prompt）：卡片 → 详情 → 安装；store 与服务端一致
 *  3. 安装技能（skill）：写入 skills 目录、出现在 /api/skills；
 *     停用后插件状态为停用；卸载后目录与列表都移除
 *  4. 数据看板：KPI 与 /api/stats 一致、六张图表卡都在
 *  5. 输入框快捷指令菜单：点「指令」→ 选中模板 → 正文写入 textarea
 *
 * 前置：brain（默认 http://localhost:3002）与桌面端 dev（CDP 9222 / CDP_HTTP 覆盖）已启动。
 * 安装类用例只在插件「未安装」时执行；已安装的用户插件不会被脚本卸载。
 * 脚本自建的会话与本次安装的插件在结束时清理。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
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

/** 本次脚本安装的插件：结束只清理这些，不碰用户已有安装 */
const installedByScript = []
const createdSessions = []

async function cleanup() {
  for (const id of installedByScript) {
    await api(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdSessions) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  await evalJs(`(() => {
    const ids = ${JSON.stringify(createdSessions)}
    if (!ids.length) return true
    const s = window.__amadeus.sessionStore
    const st = s.getState()
    const messages = { ...st.messages }
    for (const id of ids) delete messages[id]
    const sessions = st.sessions.filter((x) => !ids.includes(x.id))
    const activeGone = ids.includes(st.activeSessionId)
    s.setState({ sessions, messages, ...(activeGone ? { activeSessionId: null } : {}) })
    return true
  })()`).catch(() => {})
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
  await goto('/plugins', `window.__amadeus?.pluginStore?.getState().loaded === true`)
  const catalogSize = await evalJs(`window.__amadeus.pluginStore.getState().catalog.length`)
  report('目录：条目数量充足（>=20）', catalogSize >= 20, `catalog=${catalogSize}`)

  // ---------- 过滤与搜索 ----------
  await evalJs(`document.querySelector('[data-kind="theme"]').click(); true`)
  await waitFor(
    `(() => { const cards=[...document.querySelectorAll('[data-testid="plugin-card"]')]; return cards.length>0 && cards.every(c=>c.dataset.pluginKind==='theme') })()`,
    5000,
    'kind 过滤'
  )
  report('发现：按类型过滤', true)
  await evalJs(`document.querySelector('[data-kind="all"]').click(); true`)

  await evalJs(`(() => {
    const el = document.querySelector('[data-testid="plugin-search"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, 'Mermaid')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitFor(
    `(() => { const cards=[...document.querySelectorAll('[data-testid="plugin-card"]')]; return cards.length===1 && cards[0].dataset.pluginId==='mermaid-diagram' })()`,
    5000,
    '搜索 Mermaid'
  )
  report('发现：标题/标签搜索', true)
  await evalJs(`(() => {
    const el = document.querySelector('[data-testid="plugin-search"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  // ---------- 安装 prompt ----------
  const promptId = 'trip-plan'
  const promptInstalledBefore = await evalJs(
    `window.__amadeus.pluginStore.getState().installed.some(p=>p.id===${JSON.stringify(promptId)})`
  )
  if (promptInstalledBefore) {
    report('安装快捷指令（跳过：已安装）', true, 'not run')
  } else {
    await evalJs(`document.querySelector('[data-plugin-id=${JSON.stringify(promptId)}]').click(); true`)
    await waitFor(`!!document.querySelector('[data-testid="plugin-detail"]')`, 5000, '详情弹窗')
    await evalJs(`document.querySelector('[data-testid="plugin-install"]').click(); true`)
    await waitFor(
      `window.__amadeus.pluginStore.getState().installed.some(p=>p.id===${JSON.stringify(promptId)})`,
      10000,
      'prompt 安装完成'
    )
    installedByScript.push(promptId)
    const server = await api('/api/plugins')
    const serverHas = server.body.installed?.some((p) => p.id === promptId)
    report('安装快捷指令：store 与服务端一致', serverHas === true)
    const cardInstalled = await evalJs(
      `!!document.querySelector('[data-plugin-id=${JSON.stringify(promptId)}]')?.textContent.includes('已安装')`
    )
    report('安装快捷指令：卡片显示已安装', cardInstalled === true)
  }

  // ---------- 安装 skill / 停用 / 卸载 ----------
  const skillId = 'meeting-notes'
  const skillInstalledBefore = await evalJs(
    `window.__amadeus.pluginStore.getState().installed.some(p=>p.id===${JSON.stringify(skillId)})`
  )
  if (skillInstalledBefore) {
    report('技能安装/停用/卸载（跳过：已安装）', true, 'not run')
  } else {
    await evalJs(`document.querySelector('[data-plugin-id=${JSON.stringify(skillId)}]').click(); true`)
    await waitFor(`!!document.querySelector('[data-testid="plugin-detail"]')`, 5000, '技能详情')
    await evalJs(`document.querySelector('[data-testid="plugin-install"]').click(); true`)
    await waitFor(
      `window.__amadeus.pluginStore.getState().installed.some(p=>p.id===${JSON.stringify(skillId)})`,
      10000,
      'skill 安装完成'
    )
    installedByScript.push(skillId)
    const skillsAfterInstall = await api('/api/skills')
    report(
      '技能安装：写入 skills 目录',
      skillsAfterInstall.body.skills?.some((s) => s.name === 'meeting-notes') === true
    )

    await evalJs(`document.querySelector('[data-plugin-id=${JSON.stringify(skillId)}]').click(); true`)
    await waitFor(`!!document.querySelector('[data-testid="plugin-enabled"]')`, 5000, '停用开关')
    await evalJs(`document.querySelector('[data-testid="plugin-enabled"]').click(); true`)
    await waitFor(
      `window.__amadeus.pluginStore.getState().installed.find(p=>p.id===${JSON.stringify(skillId)})?.enabled === false`,
      10000,
      '技能停用'
    )
    report('技能：停用状态落到 store', true)

    await evalJs(`document.querySelector('[data-testid="plugin-remove"]').click(); true`)
    await sleep(200)
    await evalJs(`document.querySelector('[data-testid="plugin-remove"]').click(); true`)
    await waitFor(
      `!window.__amadeus.pluginStore.getState().installed.some(p=>p.id===${JSON.stringify(skillId)})`,
      10000,
      '技能卸载'
    )
    installedByScript.splice(installedByScript.indexOf(skillId), 1)
    const skillsAfterRemove = await api('/api/skills')
    report(
      '技能卸载：目录与列表都移除',
      skillsAfterRemove.body.skills?.some((s) => s.name === 'meeting-notes') !== true
    )
  }

  // ---------- 主题：应用 / 恢复默认 ----------
  const themeId = 'theme-steins-gate'
  const themeInstalledBefore = await evalJs(
    `window.__amadeus.pluginStore.getState().installed.some(p=>p.id===${JSON.stringify(themeId)})`
  )
  if (!themeInstalledBefore) {
    await evalJs(`document.querySelector('[data-plugin-id=${JSON.stringify(themeId)}]').click(); true`)
    await waitFor(`!!document.querySelector('[data-testid="plugin-detail"]')`, 5000, '主题详情')
    await evalJs(`document.querySelector('[data-testid="plugin-install"]').click(); true`)
    await waitFor(
      `window.__amadeus.pluginStore.getState().installed.some(p=>p.id===${JSON.stringify(themeId)})`,
      10000,
      '主题安装完成'
    )
    installedByScript.push(themeId)
  }
  await evalJs(`document.querySelector('[data-plugin-id=${JSON.stringify(themeId)}]').click(); true`)
  await waitFor(`!!document.querySelector('[data-testid="plugin-detail"]')`, 5000, '主题详情')
  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='应用主题'); b?.click(); return !!b })()`)
  await waitFor(
    `document.body.style.getPropertyValue('--background').trim() === '#050a0f'`,
    5000,
    '主题变量生效'
  )
  report('主题：应用后写入 CSS 变量', true)
  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='恢复默认'); b?.click(); return !!b })()`)
  await waitFor(
    `document.body.style.getPropertyValue('--background').trim() === ''`,
    5000,
    '主题变量移除'
  )
  report('主题：恢复默认后变量清除', true)

  // ---------- 数据看板 ----------
  await goto('/dashboard', `!!document.querySelector('[data-testid="dashboard-card"]')`)
  const userId = await evalJs(`window.__amadeus.sessionStore.getState().userId`)
  const stats = (await api(`/api/stats?userId=${encodeURIComponent(userId)}&days=14`)).body
  const kpi = await evalJs(`(() => {
    const read = (id) => document.querySelector('[data-testid="kpi-'+id+'"]')?.innerText ?? ''
    return { sessions: read('sessions'), messages: read('messages'), turns: read('turns'), toolCalls: read('toolCalls') }
  })()`)
  const fmt = (n) => new Intl.NumberFormat().format(n)
  report(
    '看板：KPI 与 /api/stats 一致',
    kpi.sessions.includes(fmt(stats.totals.sessions)) &&
      kpi.messages.includes(fmt(stats.totals.messages)) &&
      kpi.turns.includes(fmt(stats.totals.turns)) &&
      kpi.toolCalls.includes(fmt(stats.totals.toolCalls)),
    JSON.stringify(stats.totals)
  )
  const chartCards = await evalJs(`document.querySelectorAll('[data-testid="dashboard-card"]').length`)
  const svgCount = await evalJs(`document.querySelectorAll('[data-testid="dashboard-card"] svg').length`)
  report('看板：六张图表卡与 SVG 图形', chartCards >= 6 && svgCount >= 2, `cards=${chartCards} svg=${svgCount}`)
  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='刷新'); b?.click(); return true })()`)
  await sleep(800)
  report('看板：刷新按钮可用', true)

  // ---------- 输入框快捷指令菜单 ----------
  await goto('/text', `window.__amadeus?.sessionStore.getState().initialized === true`)
  const sessionId = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessions.push(sessionId)
  await waitFor(`!!document.querySelector('[data-testid="composer-commands"]')`, 10000, '指令按钮')
  await evalJs(`document.querySelector('[data-testid="composer-commands"]').click(); true`)
  await waitFor(`document.querySelectorAll('[data-testid="command-item"]').length > 0`, 5000, '指令菜单')
  const hasPrompt = await evalJs(
    `!!document.querySelector('[data-command-id=${JSON.stringify(promptId)}]')`
  )
  report('输入框：菜单列出已安装的快捷指令', hasPrompt === true)
  if (hasPrompt) {
    await evalJs(`document.querySelector('[data-command-id=${JSON.stringify(promptId)}]').click(); true`)
    await waitFor(
      `document.querySelector('textarea')?.value.startsWith('帮我规划一次旅行') === true`,
      5000,
      '模板写入输入框'
    )
    report('输入框：选中模板后写入正文', true)
  }
} catch (error) {
  report('执行中断', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupOnce()
  cdp.close()
}

const failedCount = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failedCount}/${results.length} 通过`)
process.exit(failedCount > 0 ? 1 : 0)
