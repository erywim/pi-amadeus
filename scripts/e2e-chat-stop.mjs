/**
 * 文本聊天流式中断 E2E（5.2「流式输出可中断」）：
 *  1. 新建会话，发送一个要求长回复的消息
 *  2. 页面内安装 store watcher：草稿累积 >10 字符的瞬间点击真实的
 *     Stop 按钮（title=停止）——delta 突发窗口约 1s，CDP 轮询会错过，
 *     页面内订阅在每次 set() 时同步触发，稳定命中流式中段
 *  3. 断言：Send 已切换为 Stop 且被点击、streaming=false、无错误提示
 *     （中止不报错）、未产生 assistant 消息（done 未触发，流被真正中止）
 * 前置：brain(3002)、桌面端 dev(9222) 已启动。
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

// ---------- 测试会话清理 ----------

/** 本脚本自建的会话 id（结束统一 DELETE，不污染真实会话库）；并记住进入脚本前的活跃会话以便还原 */
const createdSessionIds = []
let prevActiveSessionId = null

/** DELETE 自建会话、摘除页面内 watcher、同步页面 store；清理失败仅告警，不掩盖原测试结果 */
async function cleanupSessions() {
  for (const id of createdSessionIds) {
    try {
      const res = await fetch(`${BRAIN}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) console.warn(`[e2e] 清理测试会话 ${id} 失败：HTTP ${res.status}`)
    } catch (error) {
      console.warn(`[e2e] 清理测试会话 ${id} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  await evalJs(`(() => {
    try { window.__stopUnsub?.() } catch {}
    const ids = ${JSON.stringify(createdSessionIds)}
    if (ids.length === 0) return true
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
  await waitFor(
    `window.__amadeus?.sessionStore.getState().initialized && window.__amadeus.sessionStore.getState().userId`,
    20000,
    'sessionStore init'
  )

  if (!(await evalJs(`window.location.pathname.includes('text')`))) {
    await evalJs(
      `window.history.pushState({}, '', '/text'); window.dispatchEvent(new PopStateEvent('popstate')); true`
    )
    await sleep(2500)
  }
  // 自建专用测试会话（结束 DELETE 清理），不把测试消息写进用户当前活跃会话；
  // 同时保证一定有活跃会话（无活动会话时欢迎屏不渲染 composer）
  prevActiveSessionId = await evalJs(`window.__amadeus.sessionStore.getState().activeSessionId ?? null`)
  const testSessionId = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessionIds.push(testSessionId)
  await waitFor(`!!document.querySelector('textarea[placeholder]')`, 10000, 'composer 渲染')

  console.log('=== 发送长消息（页面内 watcher 于流式中段点击 Stop） ===')
  const filled = await evalJs(`(() => {
    const ta = document.querySelector('textarea[placeholder]');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '请用很长的篇幅详细介绍命运石之门0的完整剧情，越详细越好');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(300)
  // 先装 watcher 再发送：草稿 >10 字符瞬间点真实 Stop 按钮
  await evalJs(`(() => {
    window.__stopProbe = { clicked: false, atDraftLen: 0 };
    const store = window.__amadeus.sessionStore;
    window.__stopUnsub = store.subscribe((s) => {
      const draft = s.stream.draft?.content ?? '';
      if (!window.__stopProbe.clicked && s.stream.streaming && draft.length > 10) {
        window.__stopProbe.atDraftLen = draft.length;
        const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('title') === '停止');
        if (b) {
          window.__stopProbe.clicked = true;
          b.click();
        }
      }
    });
    return true;
  })()`)
  const clicked = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('title') === '发送');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  report('消息已发送（textarea 填充 + 发送按钮）', filled === true && clicked === true)

  await waitFor(`window.__stopProbe?.clicked`, 90000, 'watcher 命中流式中段并点击 Stop')
  report(
    'Stop 按钮在流式中被点击（Send→Stop 切换 + 草稿已累积）',
    true,
    `atDraftLen=${await evalJs(`window.__stopProbe.atDraftLen`)}`
  )

  await sleep(800)
  const streamingNow = await evalJs(`window.__amadeus.sessionStore.getState().stream.streaming`)
  report('点击后流式已终止（streaming=false）', streamingNow === false)

  const noError = await evalJs(`!document.body.textContent.includes('短路')`)
  report('中止不报错（无错误提示）', noError === true)

  const msgRoles = await evalJs(`(() => {
    const s = window.__amadeus.sessionStore.getState();
    return (s.messages[s.activeSessionId] ?? []).map((m) => m.role);
  })()`)
  report(
    '未产生 assistant 消息（done 未触发，流被真正中止）',
    Array.isArray(msgRoles) && !msgRoles.includes('assistant'),
    JSON.stringify(msgRoles)
  )

  await evalJs(`try { window.__stopUnsub?.() } catch {} true`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  await cleanupOnce()
  cdp.close()
}
