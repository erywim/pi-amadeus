/**
 * 语音回合打断 E2E（5.3「用户重新说话可打断当前 TTS 队列」）：
 *  1. 调试输入发起回合 1（长回复，TTS 播放中）
 *  2. 播放中发起回合 2 → 断言：回合 1 的 TTS 口型驱动立即停止
 *     （lipSyncValue 归零且不再被 LFO 更新）、对话框被清空重建
 *  3. 回合 2 正常完成，对话框只有回合 2 的中文回复
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const BRAIN = 'http://localhost:3002'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const res = await fetch(`${CDP_HTTP}/json/list`)
const targets = await res.json()
const target = targets.find((t) => t.type === 'page')
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
  if (r.exceptionDetails) throw new Error(`页面脚本异常: ${r.exceptionDetails.text}`)
  return r.result.value
}
async function waitFor(expression, timeoutMs = 90000, label = expression) {
  const start = Date.now()
  for (;;) {
    const v = await evalJs(expression)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(150)
  }
}
async function setTextarea(selector, text) {
  await evalJs(`(() => {
    const ta = document.querySelector(${JSON.stringify(selector)});
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}
async function clickSend() {
  return evalJs(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('发送') || x.textContent.includes('Send')); if (!b) return false; b.click(); return true })()`
  )
}

// ---------- 测试会话清理 ----------

/** 本脚本自建的会话 id（结束统一 DELETE，不污染真实会话库）；并记住进入脚本前的活跃会话以便还原 */
const createdSessionIds = []
let prevActiveSessionId = null

/** DELETE 自建会话并同步页面 store；清理失败仅告警，不掩盖原测试结果 */
async function cleanupSessions() {
  for (const id of createdSessionIds) {
    try {
      const res = await fetch(`${BRAIN}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) console.warn(`[e2e] 清理测试会话 ${id} 失败：HTTP ${res.status}`)
    } catch (error) {
      console.warn(`[e2e] 清理测试会话 ${id} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  if (createdSessionIds.length === 0) return
  await evalJs(`(() => {
    const ids = ${JSON.stringify(createdSessionIds)}
    const s = window.__amadeus.sessionStore
    const st = s.getState()
    const messages = { ...st.messages }
    for (const id of ids) delete messages[id]
    const sessions = st.sessions.filter((x) => !ids.includes(x.id))
    const activeGone = ids.includes(st.activeSessionId)
    s.setState({ sessions, messages, ...(activeGone ? { activeSessionId: null } : {}) })
    const prev = ${JSON.stringify(prevActiveSessionId)}
    if (activeGone && prev && sessions.some((x) => x.id === prev)) s.getState().selectSession(prev)
    return true
  })()`).catch((error) => console.warn(`[e2e] 页面侧会话状态同步失败：${error instanceof Error ? error.message : error}`))
}

// ---------- 信号兜底清理：Ctrl+C（SIGINT）/SIGTERM 时 try/finally 不会执行 ----------
let cleanupPromise = null
/** 收尾 + 信号兜底共用的一次性清理（多路触发只跑一次；失败仅告警，不掩盖原测试结果） */
function cleanupOnce() {
  cleanupPromise ??= cleanupSessions().catch((error) =>
    console.warn(`[e2e] 清理失败：${error instanceof Error ? error.message : error}`)
  )
  return cleanupPromise
}
let signalExitCode = null
/** 首次信号：清理后按信号码退出（SIGINT=130/SIGTERM=143）；清理中再次收到信号则立即退出，防清理卡死 */
function onSignal(code) {
  if (signalExitCode !== null) process.exit(code)
  signalExitCode = code
  void cleanupOnce().then(() => process.exit(code))
}
process.on('SIGINT', () => onSignal(130))
process.on('SIGTERM', () => onSignal(143))

try {
  await cdp.call('Runtime.enable')
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(`window.__amadeus?.sessionStore.getState().userId`, 20000, 'userId')
  await evalJs(`window.history.pushState({}, '', '/companion'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(2500)
  await evalJs(`window.__amadeus.uiStore.getState().closeLogin(); true`)
  await sleep(400)

  // 自建专用测试会话：两个语音回合落库到它，结束 DELETE，不污染用户当前活跃会话
  prevActiveSessionId = await evalJs(`window.__amadeus.sessionStore.getState().activeSessionId ?? null`)
  const testSessionId = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessionIds.push(testSessionId)

  console.log('=== 回合 1（长回复，TTS 播放中） ===')
  await setTextarea('textarea', '请用三句话介绍一下你自己')
  await sleep(300)
  report('回合 1 已发起', (await clickSend()) === true)
  // 中文开始上屏（此时日文 TTS 音频已或即将进入播放队列）
  await waitFor(
    `(window.__amadeus.uiStore.getState().dialogText ?? '').length > 10`,
    90000,
    '回合 1 中文上屏'
  )
  await sleep(1200) // 确保 TTS 播放已启动
  const turn1Text = await evalJs(`window.__amadeus.uiStore.getState().dialogText`)
  report('回合 1 中文回复上屏', turn1Text.length > 10, turn1Text.slice(0, 30))

  console.log('=== 回合 2 打断回合 1 ===')
  await setTextarea('textarea', '你好')
  await sleep(200)
  report('回合 2 已发起', (await clickSend()) === true)
  // 打断后立即采样口型驱动值：停止后应为 0 且不再被 LFO 更新
  await sleep(300)
  const lipSamples = []
  for (let i = 0; i < 3; i++) {
    lipSamples.push(await evalJs(`window.__amadeus.live2dSpeechStore.getState().lipSyncValue`))
    await sleep(200)
  }
  const allZero = lipSamples.every((v) => v === 0)
  report('回合 1 TTS 立即停播（口型驱动归零且无 LFO 更新）', allZero, `samples=${JSON.stringify(lipSamples)}`)
  const dialogReset = await evalJs(
    `(() => { const d = window.__amadeus.uiStore.getState().dialogText ?? ''; return !d.includes(${JSON.stringify(turn1Text.slice(0, 12))}); })()`
  )
  report('对话框已清空重建（不含回合 1 文本）', dialogReset === true)

  console.log('=== 回合 2 正常完成 ===')
  await waitFor(
    `(() => {
      const s = window.__amadeus.sessionStore.getState();
      const msgs = s.messages[s.activeSessionId] ?? [];
      return msgs.some(m => m.role === 'assistant' && m.ttsText);
    })()`,
    90000,
    '回合 2 完成（助手 ttsText 落库）'
  )
  const finalDialog = await evalJs(`window.__amadeus.uiStore.getState().dialogText`)
  report('回合 2 中文回复上屏', finalDialog.length > 3 && !finalDialog.includes(turn1Text.slice(0, 12)), finalDialog.slice(0, 40))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  await cleanupOnce()
  cdp.close()
}
