/**
 * 第二轮借鉴能力 E2E（CDP 驱动真实 Electron + 真实 brain + 真实 git 仓库）：
 *  1. 每回合改动卡：让模型用 bash 真实写一个文件 → 助手的回复下出现改动卡 →
 *     点文件名在右侧工作区面板打开该文件的 diff → 内容与磁盘一致
 *  2. 会话归档：归档后从主列表消失、出现在「已归档」分区；恢复后回到主列表
 *  3. 快捷键速查：⌘/ 打开、列出键位、Esc 关闭；命令面板里也能打开
 *  4. 无 bug 的干净回合不应产生改动卡（不伪造数据）
 *
 * 前置：brain（默认 3002）与桌面端 dev（CDP 默认 9222，可用 CDP_HTTP 覆盖）已启动，LLM 可用。
 * 测试自建会话与临时文件，结束统一清理（删除文件、会话与归档状态）。
 */
import { existsSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP  ${name} — ${reason}`)
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
      const transient = /Promise was collected|Cannot find context|Execution context was destroyed|Target closed/i.test(
        message
      )
      if (attempt < 2 && transient) {
        await sleep(200)
        continue
      }
      throw error
    }
  }
}
async function waitFor(expression, timeoutMs = 30_000, label = expression) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(expression)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(250)
  }
}
const click = (selector) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.click()
    return true
  })()`

const stamp = Date.now()
const probeFile = `e2e-changed-${stamp}.txt`
let prevActiveSessionId = null
const createdSessionIds = []

async function cleanup() {
  for (const id of createdSessionIds) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  const probePath = new URL(`../${probeFile}`, import.meta.url)
  if (existsSync(probePath)) rmSync(probePath, { force: true })
  await evalJs(`(() => {
    const ids = ${JSON.stringify(createdSessionIds)}
    if (ids.length === 0) return true
    const store = window.__amadeus.sessionStore
    const state = store.getState()
    const messages = { ...state.messages }
    for (const id of ids) delete messages[id]
    const sessions = state.sessions.filter((item) => !ids.includes(item.id))
    const activeGone = ids.includes(state.activeSessionId)
    store.setState({ sessions, messages, ...(activeGone ? { activeSessionId: null } : {}) })
    const prev = ${JSON.stringify(prevActiveSessionId)}
    if (activeGone && prev && sessions.some((item) => item.id === prev)) {
      store.getState().selectSession(prev)
    }
    return true
  })()`).catch(() => {})
}

let cleaned = false
async function cleanupOnce() {
  if (cleaned) return
  cleaned = true
  await cleanup()
}

try {
  await evalJs(`location.pathname === '/text' ? true : (location.href = '/text', true)`)
  await sleep(1200)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().initialized && !!window.__amadeus.sessionStore.getState().userId`,
    20_000,
    'sessionStore init'
  )
  prevActiveSessionId = await evalJs(
    `window.__amadeus.sessionStore.getState().activeSessionId ?? null`
  )
  const sid = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessionIds.push(sid)

  // ---------- 1. 改动卡（真实 bash 写文件） ----------
  const prompt =
    `请用 bash 执行这条命令：printf 'amadeus changed ${stamp}\\n' > ${probeFile} 。` +
    '执行成功后只回复：已写入。'
  await evalJs(
    `window.__amadeus.sessionStore.getState().sendMessage(${JSON.stringify(prompt)})`
  )
  // bash 需要确认：等到确认卡出现就放行（模型可能不调用 bash，超时后改判）
  let bashRan = false
  try {
    await waitFor(
      `!!document.querySelector('[data-testid="bash-confirm-approve"]')`,
      60_000,
      'bash 确认卡'
    )
    await evalJs(click('[data-testid="bash-confirm-approve"]'))
    bashRan = true
  } catch {
    bashRan = false
  }

  await waitFor(
    `!window.__amadeus.sessionStore.getState().stream.streaming`,
    180_000,
    '回合结束'
  )
  const llmFailed = await evalJs(
    `!!window.__amadeus.sessionStore.getState().turnErrors[${JSON.stringify(sid)}]`
  )
  if (llmFailed) {
    skip('改动卡：真实回合后出现', '本机 LLM 不可用')
    skip('改动卡：点文件名打开 diff', '本机 LLM 不可用')
  } else if (!bashRan) {
    skip('改动卡：真实回合后出现', '模型没有调用 bash')
    skip('改动卡：点文件名打开 diff', '模型没有调用 bash')
  } else {
    const probeExists = existsSync(new URL(`../${probeFile}`, import.meta.url))
    report('改动卡：模型真实写入了文件', probeExists, probeFile)
    await waitFor(
      `!!document.querySelector('[data-testid="changed-files-card"]')`,
      15_000,
      '改动卡出现'
    )
    const cardText = await evalJs(
      `document.querySelector('[data-testid="changed-files-card"]')?.textContent ?? ''`
    )
    const listed = await evalJs(
      `[...document.querySelectorAll('[data-testid="changed-file"]')].map((el) => el.dataset.path)`
    )
    report(
      '改动卡：列出本回合真实改动的文件',
      listed.includes(probeFile) && cardText.includes('本回合改动'),
      JSON.stringify(listed).slice(0, 120)
    )

    // 点文件名 → 工作区面板打开 diff
    await evalJs(
      `document.querySelector('[data-testid="changed-file"][data-path="${probeFile}"]').click(); true`
    )
    await waitFor(`!!document.querySelector('[data-testid="workspace-view"]')`, 8000, '工作区面板')
    await waitFor(
      `document.querySelector('[role="dialog"]')?.textContent?.includes(${JSON.stringify(probeFile)})`,
      10_000,
      'diff 弹窗'
    )
    const diffText = await evalJs(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
    report(
      '改动卡：点文件名打开该文件的 diff',
      diffText.includes(probeFile) && diffText.includes(`amadeus changed ${stamp}`),
      diffText.slice(0, 90).replace(/\n/g, ' ')
    )
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
    await sleep(400)
  }

  // ---------- 2. 干净回合不产生改动卡 ----------
  if (!llmFailed) {
    const before = await evalJs(
      `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}].length`
    )
    await evalJs(`window.__amadeus.sessionStore.getState().sendMessage('只回复：收到')`)
    await waitFor(
      `!window.__amadeus.sessionStore.getState().stream.streaming &&
       window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}].length > ${before}`,
      120_000,
      '干净回合结束'
    )
    const cards = await evalJs(
      `document.querySelectorAll('[data-testid="changed-files-card"]').length`
    )
    // 第一条助手回复带卡（真实写入），干净回合不能新增第二张
    report('干净回合：不伪造改动卡', cards <= 1, `cards=${cards}`)
  } else {
    skip('干净回合：不伪造改动卡', '本机 LLM 不可用')
  }

  // ---------- 3. 快捷键速查 ----------
  await evalJs(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true })); true`
  )
  await waitFor(`!!document.querySelector('[data-testid="shortcuts-dialog"]')`, 5000, '快捷键速查')
  const sheetText = await evalJs(
    `document.querySelector('[data-testid="shortcuts-dialog"]')?.textContent ?? ''`
  )
  report(
    '快捷键速查：⌘/ 打开并列出键位',
    sheetText.includes('命令面板') && sheetText.includes('发送消息') && sheetText.includes('@'),
    sheetText.slice(0, 80).replace(/\n/g, ' ')
  )
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
  await waitFor(`!document.querySelector('[data-testid="shortcuts-dialog"]')`, 5000, '速查关闭')
  report('快捷键速查：Esc 关闭', true)

  // 命令面板里也能打开
  await evalJs(`window.__amadeus.uiStore.getState().setCommandPaletteOpen(false); true`)
  await evalJs(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); true`
  )
  await waitFor(`!!document.querySelector('[data-testid="palette-input"]')`, 5000, '命令面板')
  const hasShortcutAction = await evalJs(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].some((el) => el.dataset.paletteId === 'action:shortcuts')`
  )
  report('快捷键速查：命令面板里有入口', hasShortcutAction === true)
  await evalJs(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); true`
  )
  await sleep(300)

  // ---------- 4. 会话归档 ----------
  await evalJs(
    `(async () => { await window.__amadeus.sessionStore.getState().renameSession(${JSON.stringify(sid)}, 'E2E 归档会话 ${stamp}'); return true })()`
  )
  await evalJs(
    `window.__amadeus.sessionStore.getState().toggleArchive(${JSON.stringify(sid)}); true`
  )
  await waitFor(
    `window.__amadeus.sessionStore.getState().sessions.find((item) => item.id === ${JSON.stringify(sid)})?.archived === true`,
    8000,
    'store 归档状态'
  )
  const serverArchived = await api(`/api/sessions?userId=${encodeURIComponent(await evalJs(`window.__amadeus.sessionStore.getState().userId`))}`)
  const serverRow = (serverArchived.body?.sessions ?? []).find((item) => item.id === sid)
  report('归档：服务端状态一致', serverRow?.archived === true, `archived=${serverRow?.archived}`)
  await waitFor(`!!document.querySelector('[data-testid="archived-sessions"]')`, 8000, '已归档分区')
  const inMain = await evalJs(
    `[...document.querySelectorAll('[data-session-id]')].some((el) => el.dataset.sessionId === ${JSON.stringify(sid)})`
  )
  report('归档：从主列表移除', inMain === false)
  await evalJs(click('[data-testid="archived-toggle"]'))
  await waitFor(
    `!!document.querySelector('[data-testid="archived-sessions"] [data-session-id="${sid}"]')`,
    5000,
    '已归档分区里可见'
  )
  report('归档：在「已归档」分区里可见', true)

  // 恢复
  await evalJs(
    `document.querySelector('[data-testid="archived-sessions"] [data-session-id="${sid}"] [data-testid="session-archive"]').click(); true`
  )
  await waitFor(
    `window.__amadeus.sessionStore.getState().sessions.find((item) => item.id === ${JSON.stringify(sid)})?.archived === false`,
    8000,
    '恢复归档'
  )
  const restoredInMain = await evalJs(
    `[...document.querySelectorAll('[data-session-id]')].some((el) => el.dataset.sessionId === ${JSON.stringify(sid)})`
  )
  report('归档：恢复后回到主列表', restoredInMain === true)

  const failed = results.filter((item) => item.ok === false)
  const skipped = results.filter((item) => item.skipped)
  console.log(
    `\n=== ${results.length - failed.length - skipped.length}/${results.length - skipped.length} 通过` +
      `${skipped.length ? `，${skipped.length} 跳过` : ''} ===`
  )
  if (failed.length > 0) {
    console.log('失败项：')
    for (const item of failed) console.log(`  - ${item.name}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`\nE2E 中断：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await cleanupOnce()
  cdp.close()
}
