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

const target = await getPageTarget()
if (!target) {
  console.error('未找到 Electron 页面目标。确认桌面端 dev 已启动（9222 调试端口）。')
  process.exit(1)
}
const cdp = await connect(target.webSocketDebuggerUrl)
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
  const onLive2d = await evalJs(cdp, `window.location.pathname.includes('live2d')`)
  if (!onLive2d) {
    await evalJs(
      cdp,
      `window.history.pushState({}, '', '/live2d'); window.dispatchEvent(new PopStateEvent('popstate')); true`
    )
    await sleep(2500)
  }
  report('进入 Live2D 页（身份就绪、状态清理）', cleanup === true)

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
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
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
        try { window.__fakeMic?.ctx?.close() } catch {}
        window.__fakeMic = { ctx, src };
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
  await evalJs(cdp, `try { window.__fakeMic?.ctx?.close(); delete window.__fakeMic } catch {} true`)
  await sleep(300)
  report('mic 关闭收尾（micActive=false）', !(await evalJs(cdp, `window.__amadeus.uiStore.getState().micActive`)))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  cdp.close()
}
