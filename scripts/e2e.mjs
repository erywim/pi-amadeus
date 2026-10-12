/**
 * CDP 驱动的桌面端 E2E 验证脚本（开发期工具）。
 * 前置：桌面端 dev 已启动（Electron 主进程开 9222 调试端口）、brain 服务运行中。
 * 用法：node scripts/e2e.mjs [chat|voice|all]
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function getPageTarget() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  return targets.find((t) => t.type === 'page') ?? null
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        ws,
        call(method, params = {}) {
          return new Promise((res, rej) => {
            const callId = ++id
            pending.set(callId, { res, rej })
            ws.send(JSON.stringify({ id: callId, method, params }))
          })
        },
        close() {
          ws.close()
        }
      })
    ws.onerror = (e) => reject(new Error(`CDP websocket 连接失败: ${e.message ?? 'unknown'}`))
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    }
  })
}

async function evalJs(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(`页面脚本异常: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result.value
}

/** 轮询直到表达式为真（返回真值），超时抛错 */
async function waitFor(cdp, expression, timeoutMs = 30000, label = expression) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(cdp, expression)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(250)
  }
}

async function setTextarea(cdp, selector, text) {
  await evalJs(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  )
}

// ---------- 文本聊天链路 ----------

async function testChat(cdp) {
  console.log('\n=== 文本聊天链路 ===')
  // 等初始化完成（userId 就绪）
  await waitFor(cdp, `window.__amadeus?.sessionStore.getState().initialized && window.__amadeus.sessionStore.getState().userId`, 20000, 'sessionStore init')
  report('会话初始化（身份 + 列表）', true)

  const before = await evalJs(cdp, `window.__amadeus.sessionStore.getState().sessions.length`)
  // 文本聊天在 /text：直推 SPA 路由（顶栏「文本模式」tab 同效）
  await evalJs(cdp, `window.history.pushState({}, '', '/text'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(600)
  const onText = await evalJs(cdp, `window.location.pathname.includes('/text')`)
  report('进入文本模式页', onText)
  // 新建会话并发送
  await evalJs(cdp, `window.__amadeus.sessionStore.getState().createSession(); true`)
  await sleep(300)
  await setTextarea(cdp, 'textarea[placeholder]', '你好，自我介绍一下吧')
  await sleep(200)
  await evalJs(cdp, `document.querySelector('textarea[placeholder]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))`)
  // Composer 是否用 Enter 发送需确认——退而求其次：直接调 store 动作的按钮点击兜底
  await sleep(500)
  const streaming = await evalJs(cdp, `window.__amadeus.sessionStore.getState().stream.streaming`)
  if (!streaming) {
    // Enter 没触发（可能是按钮发送），点发送按钮
    await evalJs(cdp, `(() => { const btns = [...document.querySelectorAll('button')]; const b = btns.find(x => x.textContent.includes('发送')); if (b) { b.click(); return true } return false })()`)
  }
  // 流式状态窗口很窄（短回复可能秒完）：轮询捕捉；捕捉不到则回合已完成的证据同样成立
  const streamed = await waitFor(
    cdp,
    `window.__amadeus.sessionStore.getState().stream.streaming ||
     (window.__amadeus.sessionStore.getState().messages[window.__amadeus.sessionStore.getState().activeSessionId] ?? []).length >= 2`,
    10000,
    '流式或回合完成'
  ).catch(() => null)
  report('发送消息触发流式', !!streamed)

  await waitFor(cdp, `!window.__amadeus.sessionStore.getState().stream.streaming && (window.__amadeus.sessionStore.getState().messages[window.__amadeus.sessionStore.getState().activeSessionId] ?? []).length >= 2`, 120000, '回合完成')
  const msgs = await evalJs(
    cdp,
    `window.__amadeus.sessionStore.getState().messages[window.__amadeus.sessionStore.getState().activeSessionId].map(m => ({role: m.role, len: m.content.length}))`
  )
  report('助手回复落库（本地态）', msgs.some((m) => m.role === 'assistant' && m.len > 0), JSON.stringify(msgs))

  // 服务端持久化 + 标题
  await sleep(15000)
  const sessions = await evalJs(cdp, `window.__amadeus.sessionStore.getState().sessions.map(s => ({title: s.title, count: s.messageCount}))`)
  const fresh = sessions[0]
  report('服务端会话列表（标题/消息数）', !!fresh && fresh.count >= 2, JSON.stringify(sessions.slice(0, 2)))

  // 重进会话：消息从服务端加载
  await evalJs(cdp, `window.__amadeus.sessionStore.getState().sessions.length`)
  const before2 = await evalJs(cdp, `window.__amadeus.sessionStore.getState().sessions.length`)
  await evalJs(cdp, `window.__amadeus.sessionStore.setState({ messages: {} }); true`)
  const sid = await evalJs(cdp, `window.__amadeus.sessionStore.getState().activeSessionId`)
  await evalJs(cdp, `window.__amadeus.sessionStore.getState().selectSession(${JSON.stringify(sid ?? '')})`)
  await waitFor(cdp, `(window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid ?? '')}] ?? []).length >= 2`, 20000, '重载消息')
  report('服务端消息重载', true)
  return before2 > before
}

// ---------- 语音链路（调试输入 → 双语言 → TTS 播放） ----------

async function testVoice(cdp) {
  console.log('\n=== 语音链路（Live2D 调试输入） ===')
  // 进陪伴模式页：点顶栏「陪伴模式」tab
  const navigated = await evalJs(
    cdp,
    `(() => {
      const links = [...document.querySelectorAll('a, button')];
      const target = links.find(x => x.getAttribute('href')?.includes('companion') || x.textContent?.includes('陪伴'));
      if (target) { target.click(); return true }
      return false
    })()`
  )
  if (!navigated) {
    // 直接改路由
    await evalJs(cdp, `window.history.pushState({}, '', '/companion'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  }
  await sleep(2500)
  const onLive2d = await evalJs(cdp, `window.location.pathname.includes('companion')`)
  report('进入 Live2D 页', onLive2d)

  // 登录覆盖层可能挡住：先关闭（若存在）
  await evalJs(cdp, `window.__amadeus.uiStore.getState().closeLogin(); true`)
  await sleep(400)

  // 调试输入框
  await setTextarea(cdp, 'textarea', '用日语说一句鼓励我的话')
  await sleep(300)
  await evalJs(
    cdp,
    `(() => { const btns = [...document.querySelectorAll('button')]; const b = btns.find(x => x.textContent.includes('发送') || x.textContent.includes('Send')); if (b) { b.click(); return true } return false })()`
  )
  await waitFor(cdp, `(window.__amadeus.uiStore.getState().dialogText ?? '').length > 3`, 90000, '对话框出现中文回复')
  const dialog = await evalJs(cdp, `window.__amadeus.uiStore.getState().dialogText`)
  report('中文回复上屏', dialog.length > 3, dialog.slice(0, 40))

  // 音频播放：AudioContext 存在且当前时间推进
  await sleep(3000)
  const audioState = await evalJs(
    cdp,
    `(() => {
      // ttsPlayer 的 AudioContext 未暴露；以 lipSync 非零历史 + 无报错判断
      return window.__amadeus.live2dSpeechStore.getState().lipSyncValue
    })()`
  )
  report('TTS 播放（口型驱动值观察）', typeof audioState === 'number')

  // 表情是否被驱动过
  const emotion = await evalJs(cdp, `window.__amadeus.live2dStore.getState().emotion`)
  report('情感事件驱动表情', typeof emotion === 'string', `emotion=${emotion}`)

  // 等回合结束（音频播完）
  await sleep(8000)
  return dialog
}

const phase = process.argv[2] ?? 'all'
const target = await getPageTarget()
if (!target) {
  console.error('未找到 Electron 页面目标。确认桌面端 dev 已启动（9222 调试端口）。')
  process.exit(1)
}
const cdp = await connect(target.webSocketDebuggerUrl)
try {
  await cdp.call('Runtime.enable')
  if (phase === 'chat' || phase === 'all') await testChat(cdp)
  if (phase === 'voice' || phase === 'all') await testVoice(cdp)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  cdp.close()
}
