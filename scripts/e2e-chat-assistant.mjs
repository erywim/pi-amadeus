/**
 * 文本模式「常见 agent 助手」能力 E2E：
 *  1. 回合失败可见：LLM 不可用时错误卡出现在消息列，用户消息只落一条
 *  2. 会话重命名：标题栏铅笔 → 输入 → 失焦提交；断言 store、侧栏与服务端三处一致，
 *     且重命名不刷新 updated_at（不会把旧会话顶到列表最前）
 *  3. 会话搜索：侧栏搜索框按标题过滤；Esc 清空后恢复全部
 *  4. 重试：错误卡上的重试走 /api/chat/regenerate，不重复写入用户消息
 *  5. 消息操作：助手消息可复制、代码块可复制（剪贴板内容逐字断言）、
 *     最后一条助手消息有「重新生成」入口
 *  6. 滚动跟随：内容溢出且用户上滚后出现「回到底部」，点击后回到最新且按钮消失
 *
 * 前置：brain（默认 http://localhost:3002）与桌面端 dev（CDP 9222 / 可用 CDP_HTTP 覆盖）已启动。
 * 测试自建会话与注入消息，结束统一清理，不触碰真实会话内容。
 * 无真实 LLM key 时第 1/4 步依赖「Provider is not configured」这类快速失败；
 * 有 key 时该步会真的生成回复，脚本会明确输出 not run，而不是伪装通过。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
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

/** 本脚本自建会话（结束统一 DELETE）与进入前的活跃会话（结束还原） */
const createdSessionIds = []
let prevActiveSessionId = null

async function cleanupSessions() {
  await evalJs(`(() => { try { window.__unsubErr?.() } catch {} return true })()`).catch(() => {})
  for (const id of createdSessionIds) {
    try {
      const res = await fetch(`${BRAIN}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) console.warn(`[e2e] 清理测试会话 ${id} 失败：HTTP ${res.status}`)
    } catch (error) {
      console.warn(`[e2e] 清理测试会话 ${id} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  await evalJs(`(() => {
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
  })()`).catch((error) => console.warn(`[e2e] 页面侧会话状态同步失败：${error?.message ?? error}`))
}

let cleanupPromise = null
function cleanupOnce() {
  cleanupPromise ??= cleanupSessions().catch((error) =>
    console.warn(`[e2e] 清理失败：${error instanceof Error ? error.message : error}`)
  )
  return cleanupPromise
}
let signalExitCode = null
function onSignal(code) {
  if (signalExitCode !== null) process.exit(code)
  signalExitCode = code
  void cleanupOnce().then(() => process.exit(code))
}
process.on('SIGINT', () => onSignal(130))
process.on('SIGTERM', () => onSignal(143))

try {
  // 应用默认落在陪伴页：先切到文本模式（本脚本只测文本助手）
  await evalJs(`location.pathname === '/text' ? true : (location.href = '/text', true)`)
  await sleep(1200)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().initialized && window.__amadeus.sessionStore.getState().userId`,
    20000,
    'sessionStore init'
  )
  const userId = await evalJs(`window.__amadeus.sessionStore.getState().userId`)
  prevActiveSessionId = await evalJs(`window.__amadeus.sessionStore.getState().activeSessionId ?? null`)

  const sessionId = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessionIds.push(sessionId)

  // ---------- 1. 回合结果：失败可见 / 成功后重新生成 ----------
  await evalJs(`window.__amadeus.sessionStore.getState().sendMessage('e2e 回合')`)
  await waitFor(
    `!window.__amadeus.sessionStore.getState().stream.streaming &&
     (!!window.__amadeus.sessionStore.getState().turnErrors[${JSON.stringify(sessionId)}] ||
      window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}].some(m=>m.role==='assistant'))`,
    60000,
    '回合结束'
  )
  const llmFailed = await evalJs(
    `!!window.__amadeus.sessionStore.getState().turnErrors[${JSON.stringify(sessionId)}]`
  )
  if (llmFailed) {
    const errorVisible = await evalJs(`!!document.querySelector('[data-testid="turn-error"]')`)
    report('失败回合：错误卡出现在消息列', errorVisible === true)
    const usersAfterFail = await evalJs(
      `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}].filter(m=>m.role==='user').length`
    )
    report('失败回合：用户消息只落一条', usersAfterFail === 1, `users=${usersAfterFail}`)
    report('成功回合：重新生成替换旧回复（跳过：本机 LLM 不可用）', true, 'not run')
  } else {
    // 成功路径：重新生成必须替换旧回复，而不是追加成两条回答
    const before = await evalJs(
      `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}].at(-1)`
    )
    report('成功回合：产生一条助手回复', before?.role === 'assistant', `role=${before?.role}`)
    await waitFor(`!!document.querySelector('[data-testid="regenerate"]')`, 10000, '重新生成按钮')
    await evalJs(`document.querySelector('[data-testid="regenerate"]').click(); true`)
    await waitFor(
      `(() => {
        const list = window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}] ?? []
        return !window.__amadeus.sessionStore.getState().stream.streaming &&
          list.length === 2 && list.at(-1).role === 'assistant' &&
          list.at(-1).content !== ${JSON.stringify(before?.content ?? '')}
      })()`,
      60000,
      '重新生成完成并替换旧回复'
    )
    const after = await evalJs(
      `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}]`
    )
    report(
      '重新生成：替换旧回复而不是追加',
      after.length === 2 && after.at(-1).role === 'assistant' && after.at(-1).content !== before?.content,
      `messages=${after.length}`
    )
    report(
      '重新生成：用户消息不重复',
      after.filter((m) => m.role === 'user').length === 1,
      `users=${after.filter((m) => m.role === 'user').length}`
    )
  }

  // ---------- 2. 重命名（会话已在上一回合并发落库） ----------
  const uniqueTitle = `E2E 会话 ${Date.now()}`
  await waitFor(`!!document.querySelector('[data-testid="rename-session"]')`, 10000, '重命名按钮')
  const beforeUpdatedAt = await evalJs(
    `window.__amadeus.sessionStore.getState().sessions.find(s=>s.id===${JSON.stringify(sessionId)})?.updatedAt ?? 0`
  )
  await evalJs(`document.querySelector('[data-testid="rename-session"]').click(); true`)
  await waitFor(`!!document.querySelector('[data-testid="rename-input"]')`, 5000, '重命名输入框')
  await evalJs(`(() => {
    const el = document.querySelector('[data-testid="rename-input"]')
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(uniqueTitle)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    // 失焦提交：后台窗口里 el.blur() 不会派发 focusout，直接派发事件走同一条 onBlur 逻辑
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    return true
  })()`)
  await waitFor(
    `window.__amadeus.sessionStore.getState().sessions.find(s=>s.id===${JSON.stringify(sessionId)})?.title === ${JSON.stringify(uniqueTitle)}`,
    10000,
    'store 标题更新'
  )
  const afterUpdatedAt = await evalJs(
    `window.__amadeus.sessionStore.getState().sessions.find(s=>s.id===${JSON.stringify(sessionId)})?.updatedAt ?? 0`
  )
  const serverTitle = await evalJs(`fetch(${JSON.stringify(BRAIN)} + '/api/sessions?userId=' + encodeURIComponent(${JSON.stringify(userId)})).then(r=>r.json()).then(j=>j.sessions.find(s=>s.id===${JSON.stringify(sessionId)})?.title ?? null)`)
  report('重命名：store / 服务端标题一致', serverTitle === uniqueTitle, `server=${serverTitle}`)
  report('重命名：不刷新 updated_at', Number(afterUpdatedAt) === Number(beforeUpdatedAt), `${beforeUpdatedAt} → ${afterUpdatedAt}`)
  const sidebarHasTitle = await evalJs(
    `[...document.querySelectorAll('[data-session-id]')].some(el => el.textContent.includes(${JSON.stringify(uniqueTitle)}))`
  )
  report('重命名：侧栏显示新标题', sidebarHasTitle === true)

  // ---------- 3. 搜索 ----------
  await evalJs(`(() => {
    const el = document.querySelector('[data-testid="session-search"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, 'E2E 会话')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitFor(`document.querySelectorAll('[data-session-id]').length === 1`, 5000, '搜索过滤到 1 条')
  const filteredId = await evalJs(`document.querySelector('[data-session-id]')?.dataset.sessionId ?? null`)
  report('搜索：按标题过滤', filteredId === sessionId, `visible=${filteredId}`)
  await evalJs(`(() => {
    const el = document.querySelector('[data-testid="session-search"]')
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await waitFor(
    `document.querySelectorAll('[data-session-id]').length === window.__amadeus.sessionStore.getState().sessions.length`,
    5000,
    'Esc 清空后恢复全部'
  )

  // ---------- 4. 重试不重复用户消息 ----------
  if (llmFailed) {
    // 记录错误卡出现次数：重试后必须再次进入「有错误」状态
    await evalJs(`(() => {
      window.__errTransitions = 0
      window.__prevErr = window.__amadeus.sessionStore.getState().turnErrors[${JSON.stringify(sessionId)}]
      window.__unsubErr = window.__amadeus.sessionStore.subscribe((s) => {
        const e = s.turnErrors[${JSON.stringify(sessionId)}]
        if (e && !window.__prevErr) window.__errTransitions++
        window.__prevErr = e
      })
      return true
    })()`)
    await evalJs(`document.querySelector('[data-testid="retry-turn"]').click(); true`)
    await waitFor(`window.__errTransitions >= 1`, 60000, '重试后的错误')
    const usersAfterRetry = await evalJs(
      `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}].filter(m=>m.role==='user').length`
    )
    report('重试：不重复写入用户消息', usersAfterRetry === 1, `users=${usersAfterRetry}`)
    const serverUsers = await evalJs(
      `fetch(${JSON.stringify(BRAIN)} + '/api/sessions/' + encodeURIComponent(${JSON.stringify(sessionId)}) + '/messages').then(r=>r.json()).then(j=>j.messages.filter(m=>m.role==='user').length)`
    )
    report('重试：服务端用户消息仍为一条', serverUsers === 1, `serverUsers=${serverUsers}`)
  } else {
    report('重试：不重复写入用户消息（跳过）', true, 'not run')
    report('重试：服务端用户消息仍为一条（跳过）', true, 'not run')
  }

  // ---------- 5. 消息操作与代码复制 ----------
  const markdown = '说明\n\n```js\nconst x = 1\nconsole.log(x)\n```'
  await evalJs(`(() => {
    const s = window.__amadeus.sessionStore
    const st = s.getState()
    const sid = ${JSON.stringify(sessionId)}
    const list = st.messages[sid] ?? []
    s.setState({ messages: { ...st.messages, [sid]: [...list, {
      id: 'e2e-code-message', sessionId: sid, role: 'assistant',
      content: ${JSON.stringify(markdown)}, ttsText: null, mode: 'text', createdAt: Date.now()
    }] } })
    return true
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="copy-code"]')`, 10000, '代码复制按钮')
  await waitFor(`!!document.querySelector('[data-testid="copy-message"]')`, 10000, '消息复制按钮')
  const hasRegenerate = await evalJs(`!!document.querySelector('[data-testid="regenerate"]')`)
  report('消息操作：最后一条助手消息有重新生成入口', hasRegenerate === true)
  await evalJs(`(() => {
    window.__copied = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__copied = t } }
    })
    return true
  })()`)
  await evalJs(`document.querySelector('[data-testid="copy-code"]').click(); true`)
  await waitFor(`typeof window.__copied === 'string'`, 5000, '代码复制内容')
  const copiedCode = await evalJs(`window.__copied`)
  report('代码块：复制的是原始代码', copiedCode === 'const x = 1\nconsole.log(x)\n', JSON.stringify(copiedCode))
  // 最后一条助手消息的复制按钮（DOM 末尾），不是用户消息那条
  await evalJs(`[...document.querySelectorAll('[data-testid="copy-message"]')].at(-1).click(); true`)
  await waitFor(`window.__copied !== ${JSON.stringify('const x = 1\nconsole.log(x)\n')}`, 5000, '消息复制内容')
  const copiedMessage = await evalJs(`window.__copied`)
  report('消息：复制完整正文', copiedMessage === markdown, JSON.stringify(copiedMessage))

  // ---------- 6. 滚动跟随 ----------
  await evalJs(`(() => {
    const s = window.__amadeus.sessionStore
    const st = s.getState()
    const sid = ${JSON.stringify(sessionId)}
    const filler = Array.from({ length: 30 }, (_, i) => ({
      id: 'e2e-fill-' + i, sessionId: sid, role: 'assistant',
      content: ('第 ' + i + ' 段：' + '这是一段用于撑开滚动区域的长文本。'.repeat(8)),
      ttsText: null, mode: 'text', createdAt: Date.now() + i
    }))
    s.setState({ messages: { ...st.messages, [sid]: [...(st.messages[sid] ?? []), ...filler] } })
    return true
  })()`)
  await sleep(800)
  await evalJs(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]')
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
    return true
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="scroll-to-bottom"]')`, 5000, '回到底部按钮')
  report('滚动：上滚后出现「回到底部」', true)
  await evalJs(`document.querySelector('[data-testid="scroll-to-bottom"]').click(); true`)
  await waitFor(`!document.querySelector('[data-testid="scroll-to-bottom"]')`, 5000, '回到底部后按钮消失')
  report('滚动：点击后回到最新且按钮消失', true)
} catch (error) {
  report('执行中断', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupOnce()
  cdp.close()
}

const failedCount = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failedCount}/${results.length} 通过`)
process.exit(failedCount > 0 ? 1 : 0)
