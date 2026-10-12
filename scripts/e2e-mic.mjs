/**
 * M4 麦克风链路 E2E：机器可能没有物理麦克风，用「合成语音假麦克风」确定性验证
 * startMic → silero VAD 切段 → /api/stt 转写 → 语音回合 的完整链路：
 *   1. 生成 TTS 日语语音（.tmp-mic-test.wav，16kHz 单声道 + 尾部静音）
 *   2. 页面内 decode 为 AudioBuffer → MediaStreamDestination 假麦克风
 *   3. 覆盖 navigator.mediaDevices.getUserMedia → 点工具栏 mic 按钮 → 播放音频
 *   4. 两轮：第一轮覆盖「模型未就绪占位 + stop 时 flush」路径；
 *      第二轮覆盖「模型就绪后静音自然触发段结束」路径（无需手动 stop）
 * 前置：brain(3002)、桌面端 dev(9222) 已启动。
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolve } from 'node:path'

const WAV_PATH = resolve(import.meta.dirname, '../.tmp-mic-test.wav')
const wavB64 = readFileSync(WAV_PATH).toString('base64')

const CDP_HTTP = 'http://127.0.0.1:9222'
const BRAIN = 'http://localhost:3002'

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
    throw new Error(
      `页面脚本异常: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`
    )
  }
  return result.result.value
}

async function waitFor(cdp, expression, timeoutMs = 30000, label = expression) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(cdp, expression)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(150)
  }
}

// ---------- 测试会话清理 ----------

/** 本脚本自建的会话 id（结束统一 DELETE，不污染真实会话库）；并记住进入脚本前的活跃会话以便还原 */
const createdSessionIds = []
let prevActiveSessionId = null

/** DELETE 自建会话并同步页面 store；清理失败仅告警，不掩盖原测试结果 */
async function cleanupSessions(cdp) {
  for (const id of createdSessionIds) {
    try {
      const res = await fetch(`${BRAIN}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) console.warn(`[e2e] 清理测试会话 ${id} 失败：HTTP ${res.status}`)
    } catch (error) {
      console.warn(`[e2e] 清理测试会话 ${id} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  if (createdSessionIds.length === 0) return
  await evalJs(
    cdp,
    `(() => {
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
    })()`
  ).catch((error) => console.warn(`[e2e] 页面侧会话状态同步失败：${error instanceof Error ? error.message : error}`))
}

const target = await getPageTarget()
if (!target) {
  console.error('未找到 Electron 页面目标。确认桌面端 dev 已启动（9222 调试端口）。')
  process.exit(1)
}
const cdp = await connect(target.webSocketDebuggerUrl)

// ---------- 信号兜底清理：Ctrl+C（SIGINT）/SIGTERM 时 try/finally 不会执行 ----------
let cleanupPromise = null
/** 收尾 + 信号兜底共用的一次性清理（多路触发只跑一次；失败仅告警，不掩盖原测试结果） */
function cleanupOnce() {
  cleanupPromise ??= (async () => {
    // 失败路径兜底：mic 还开着就关掉并还原假麦克风补丁，不留尾巴（正常路径收尾已做过，幂等）
    await evalJs(
      cdp,
      `(() => {
        try { if (window.__amadeus?.uiStore?.getState().micActive) document.querySelector('div.absolute.right-4 button')?.click() } catch {}
        try { window.__fakeMic?.restore() } catch {}
        return true
      })()`
    ).catch(() => {})
    await cleanupSessions(cdp)
  })().catch((error) => console.warn(`[e2e] 清理失败：${error instanceof Error ? error.message : error}`))
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
  console.log('\n=== M4 麦克风 VAD+STT 链路（合成语音假麦克风） ===')

  // 就绪：userId + Live2D 页 + 登录层关闭 + 残留状态清理
  await waitFor(cdp, `window.__amadeus?.sessionStore.getState().userId`, 20000, 'userId')
  await evalJs(cdp, `try { window.__fakeMic?.restore() } catch {} true`)
  const cleanup = await evalJs(
    cdp,
    `(() => {
      if (window.__amadeus.uiStore.getState().micActive) {
        document.querySelector('div.absolute.right-4 button')?.click()
      }
      window.__amadeus.uiStore.getState().closeLogin()
      return true
    })()`
  )
  await sleep(500)
  const onLive2d = await evalJs(cdp, `window.location.pathname.includes('companion')`)
  if (!onLive2d) {
    await evalJs(
      cdp,
      `window.history.pushState({}, '', '/companion'); window.dispatchEvent(new PopStateEvent('popstate')); true`
    )
    await sleep(2500)
  }
  report('进入 Live2D 页（身份就绪、状态清理）', cleanup === true)

  // 自建专用测试会话：语音回合落库到它，结束 DELETE，不污染用户当前活跃会话
  prevActiveSessionId = await evalJs(cdp, `window.__amadeus.sessionStore.getState().activeSessionId ?? null`)
  const testSessionId = await evalJs(cdp, `window.__amadeus.sessionStore.getState().createSession()`)
  createdSessionIds.push(testSessionId)

  // 公共注入：假麦克风 + fetch 包装捕获 STT 响应
  const inject = (() => {
    const b64 = wavB64
    return `(async () => {
      try {
        const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
        const ctx = new AudioContext({ sampleRate: 16000 });
        if (ctx.state === 'suspended') await ctx.resume();
        const buffer = await ctx.decodeAudioData(bytes.buffer);
        const dest = ctx.createMediaStreamDestination();
        const src = ctx.createBufferSource();
        src.buffer = buffer; src.connect(dest);
        // 上一轮残留先整体还原（getUserMedia 补丁/音轨/AudioContext），再装本轮
        try { window.__fakeMic?.restore() } catch {}
        // 真·原实现只捕获一次放页面全局：否则第二轮会把上一轮的补丁当作"原实现"还原回去
        const origGetUserMedia = (window.__origGetUserMedia ??= navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices));
        navigator.mediaDevices.getUserMedia = () => Promise.resolve(dest.stream);
        if (!window.__sttCalls) {
          const origFetch = window.fetch.bind(window);
          window.__sttCalls = [];
          window.fetch = async (...args) => {
            const res = await origFetch(...args);
            if (String(args[0]).includes('/api/stt')) {
              const clone = res.clone();
              const body = await clone.json().catch(() => ({}));
              window.__sttCalls.push({ status: res.status, text: body.text ?? '' });
            }
            return res;
          };
        }
        window.__fakeMic = {
          ctx,
          src,
          restore: () => {
            // 还原 getUserMedia 补丁、停掉合成音轨、关 AudioContext，并清掉页面全局，不留尾巴
            try { navigator.mediaDevices.getUserMedia = origGetUserMedia } catch {}
            try { src.stop() } catch {}
            try { dest.stream.getTracks().forEach((t) => t.stop()) } catch {}
            try { ctx.close() } catch {}
            try { delete window.__fakeMic } catch {}
          }
        };
        return { ok: true, seconds: buffer.duration };
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`
  })()

  // ---------- 第一轮：模型可能尚未加载（占位 VAD），stop 时 flush 触发切段 ----------
  console.log('\n-- 第一轮：占位/加载期路径（stop → flush → STT） --')
  const inj1 = await evalJs(cdp, inject)
  report('注入假麦克风（第 1 轮）', inj1?.ok === true, JSON.stringify(inj1))
  const sttBefore1 = await evalJs(cdp, `window.__sttCalls.length`)
  await evalJs(cdp, `(() => { document.querySelector('div.absolute.right-4 button')?.click(); return true })()`)
  await waitFor(cdp, `window.__amadeus.uiStore.getState().micActive`, 10000, 'micActive=true')
  report('mic 按钮开启（micActive=true）', true)
  await evalJs(cdp, `window.__fakeMic.src.start(); true`)

  // 播完（~4.1s）再等 2s，然后 stop 触发 flush
  await sleep(6500)
  await evalJs(cdp, `(() => { document.querySelector('div.absolute.right-4 button')?.click(); return true })()`)
  report('mic 按钮关闭触发 flush', !(await evalJs(cdp, `window.__amadeus.uiStore.getState().micActive`)))
  const stt1 = await waitFor(
    cdp,
    `window.__sttCalls.length > ${sttBefore1} && window.__sttCalls[window.__sttCalls.length - 1]`,
    40000,
    '第 1 轮 STT 请求'
  )
  report(
    'VAD 切段 + STT 转写（第 1 轮）',
    stt1.status === 200 && stt1.text.length > 0,
    `status=${stt1.status} text=${stt1.text}`
  )

  // 语音回合回复
  await waitFor(
    cdp,
    `(() => { const d = window.__amadeus.uiStore.getState().dialogText ?? ''; return d.length > 3 && !d.startsWith('你说：') })()`,
    120000,
    '第 1 轮语音回合回复'
  )
  const reply1 = await evalJs(cdp, `window.__amadeus.uiStore.getState().dialogText`)
  report('语音回合中文回复上屏（第 1 轮）', reply1.length > 3, reply1.slice(0, 50))

  // 落库断言
  const persisted = await waitFor(
    cdp,
    `(() => {
      const s = window.__amadeus.sessionStore.getState();
      const msgs = s.messages[s.activeSessionId] ?? [];
      // whisper 转写有随机丢词（天気→いいですね），断言稳定子串
      const u = msgs.find(m => m.role === 'user' && m.mode === 'voice' && /今日|いい/.test(m.content ?? ''));
      const a = msgs.find(m => m.role === 'assistant' && m.ttsText);
      return u && a ? { u: u.content, tts: a.ttsText } : null;
    })()`,
    30000,
    '语音消息落库'
  )
  report(
    '语音回合落库（user voice + assistant ttsText）',
    true,
    `user=${persisted.u.slice(0, 30)} tts=${persisted.tts.slice(0, 30)}`
  )

  // ---------- 第二轮：模型已就绪，静音自然触发段结束（无需 stop） ----------
  console.log('\n-- 第二轮：silero 自然段结束路径 --')
  const inj2 = await evalJs(cdp, inject)
  report('注入假麦克风（第 2 轮）', inj2?.ok === true)
  const sttBefore2 = await evalJs(cdp, `window.__sttCalls.length`)
  await evalJs(cdp, `(() => { document.querySelector('div.absolute.right-4 button')?.click(); return true })()`)
  await waitFor(cdp, `window.__amadeus.uiStore.getState().micActive`, 10000, 'micActive=true（第 2 轮）')
  await evalJs(cdp, `window.__fakeMic.src.start(); true`)

  // 不点 stop：silero 检测到尾部静音后应自动结束段并触发 STT
  const stt2 = await waitFor(
    cdp,
    `window.__sttCalls.length > ${sttBefore2} && window.__sttCalls[window.__sttCalls.length - 1]`,
    45000,
    '第 2 轮 STT（自然段结束）'
  )
  report(
    'silero 静音自然切段 + STT（第 2 轮，无手动 stop）',
    stt2.status === 200 && stt2.text.length > 0,
    `status=${stt2.status} text=${stt2.text}`
  )

  await waitFor(
    cdp,
    `(() => { const d = window.__amadeus.uiStore.getState().dialogText ?? ''; return d.length > 3 && !d.startsWith('你说：') })()`,
    120000,
    '第 2 轮语音回合回复'
  )
  const reply2 = await evalJs(cdp, `window.__amadeus.uiStore.getState().dialogText`)
  report('语音回合中文回复上屏（第 2 轮）', reply2.length > 3, reply2.slice(0, 50))

  // 收尾：关 mic + 还原 patch
  await evalJs(cdp, `(() => { if (window.__amadeus.uiStore.getState().micActive) document.querySelector('div.absolute.right-4 button')?.click(); return true })()`)
  await evalJs(cdp, `try { window.__fakeMic?.restore() } catch {} true`)
  await sleep(300)
  report('mic 关闭收尾（micActive=false）', !(await evalJs(cdp, `window.__amadeus.uiStore.getState().micActive`)))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  await cleanupOnce()
  cdp.close()
}
