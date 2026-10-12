/**
 * M5 视觉输入 E2E：
 *  A. 桌面端摄像头链路：canvas.captureStream 假摄像头 → 点工具栏 video 按钮
 *     → 帧定时上传 /api/frames（服务端保留最近 2 帧）
 *  B. 纯文本模型门控：Electron 用户（deepseek-v4-pro）语音回合 →
 *     大脑日志出现「不支持图像输入，跳过 2 帧」警告（证明帧已到达且门控生效）
 *  C. 视觉模型附加：测试用户配 gpt-4o-mini（aihubmix 中转 + Clash 代理）→
 *     上传红色图片帧 → 语音回合 → 回复描述图片主色调（证明 image content 块真正进了 LLM）
 * 前置：brain(3002)、桌面端 dev(9222) 已启动；usage: node scripts/e2e-vision.mjs <brainLogPath>
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolve } from 'node:path'

const BRAIN = 'http://localhost:3002'
const CDP_HTTP = 'http://127.0.0.1:9222'
const brainLogPath = process.argv[2] ?? ''

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------- CDP 工具 ----------

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

// ---------- 环境密钥 ----------

const envPath = resolve(import.meta.dirname, '../services/brain/.env')
const whisperKey = readFileSync(envPath, 'utf8')
  .split('\n')
  .find((l) => l.startsWith('WHISPER_API_KEY='))
  .slice('WHISPER_API_KEY='.length)
  .trim()

// ---------- 主流程 ----------

const target = await getPageTarget()
if (!target) {
  console.error('未找到 Electron 页面目标。')
  process.exit(1)
}
const cdp = await connect(target.webSocketDebuggerUrl)
try {
  await cdp.call('Runtime.enable')

  console.log('\n=== A. 桌面端摄像头链路（假摄像头） ===')
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(cdp, `window.__amadeus?.sessionStore.getState().userId`, 20000, 'userId')
  await evalJs(cdp, `window.__amadeus.uiStore.getState().closeLogin(); true`)
  if (!(await evalJs(cdp, `window.location.pathname.includes('companion')`))) {
    await evalJs(
      cdp,
      `window.history.pushState({}, '', '/companion'); window.dispatchEvent(new PopStateEvent('popstate')); true`
    )
    await sleep(2000)
  }

  // 假摄像头：canvas 动画（红色底 + 白色圆）→ captureStream
  const injected = await evalJs(
    cdp,
    `(() => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 240;
        const ctx = canvas.getContext('2d');
        let tick = 0;
        const draw = () => {
          ctx.fillStyle = '#cc0000'; ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(160 + Math.sin(tick / 20) * 60, 120, 40, 0, Math.PI * 2);
          ctx.fill();
          tick++;
          requestAnimationFrame(draw);
        };
        draw();
        const stream = canvas.captureStream(10);
        const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (constraints) => {
          if (constraints && constraints.video) return Promise.resolve(stream);
          return orig(constraints);
        };
        window.__fakeCamera = { canvas, restore: () => { navigator.mediaDevices.getUserMedia = orig } };
        return true;
      } catch (e) { return String(e); }
    })()`
  )
  report('注入假摄像头（canvas 动画流）', injected === true, String(injected))

  // 点 video 按钮（工具栏第二个）
  await evalJs(cdp, `(() => { const b = document.querySelectorAll('div.absolute.right-4 button')[1]; if (!b) return false; b.click(); return true })()`)
  await waitFor(cdp, `window.__amadeus.uiStore.getState().cameraActive`, 10000, 'cameraActive=true')
  report('video 按钮开启（cameraActive=true）', true)
  await sleep(3500) // 帧定时 1.2s → 至少上传 2 帧
  await evalJs(cdp, `(() => { const b = document.querySelectorAll('div.absolute.right-4 button')[1]; b?.click(); return true })()`)
  await sleep(300)
  report('video 按钮关闭（cameraActive=false）', !(await evalJs(cdp, `window.__amadeus.uiStore.getState().cameraActive`)))
  await evalJs(cdp, `try { window.__fakeCamera.restore() } catch {} true`)

  console.log('\n=== B. 纯文本模型门控（deepseek-v4-pro 跳过视觉帧） ===')
  const markLen = brainLogPath ? readFileSync(brainLogPath, 'utf8').length : 0
  // Electron 用户语音回合（服务端取 framesOf）
  const resB = await fetch(`${BRAIN}/api/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: '33f8a269-b416-46e9-9b6a-07177a85a9a2',
      sessionId: 'vision-gate-test-session',
      text: '请随便说一句话'
    })
  })
  let cnB = ''
  if (resB.ok && resB.body) {
    const reader = resB.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              const ev = JSON.parse(payload)
              if (ev.type === 'delta') cnB += ev.delta
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }
  report('门控测试语音回合完成', cnB.length > 3, `cn=${cnB.slice(0, 30)}`)
  await sleep(1000)
  const logTail = brainLogPath ? readFileSync(brainLogPath, 'utf8').slice(markLen) : ''
  const skipped = /跳过 \d+ 帧视觉输入/.exec(logTail)
  report('帧已到达服务端 + 纯文本模型跳过（大脑日志）', !!skipped, skipped?.[0] ?? '(log 无匹配)')

  console.log('\n=== C. 视觉模型附加（gpt-4o-mini 看到图片） ===')
  // 测试用户 + 视觉模型配置（aihubmix + Clash 代理）
  const uidRes = await fetch(`${BRAIN}/api/users/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'vision-e2e-user' })
  })
  const visionUserId = (await uidRes.json()).userId
  const cfgRes = await fetch(`${BRAIN}/api/config/${visionUserId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        provider: {
          baseUrl: 'https://aihubmix.com/v1',
          apiKey: whisperKey,
          model: 'gpt-4o-mini',
          proxy: 'http://127.0.0.1:7890'
        }
      }
    })
  })
  report('测试用户配视觉模型（aihubmix gpt-4o-mini）', cfgRes.ok, `status=${cfgRes.status}`)

  // 从页面画布取红色图 JPEG base64 → 上传 2 帧
  const jpegB64 = await evalJs(
    cdp,
    `(() => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const x = c.getContext('2d');
      x.fillStyle = '#cc0000'; x.fillRect(0, 0, 320, 240);
      x.fillStyle = '#ffffff'; x.beginPath(); x.arc(160, 120, 50, 0, Math.PI * 2); x.fill();
      return c.toDataURL('image/jpeg', 0.8).split(',')[1];
    })()`
  )
  for (let i = 0; i < 2; i++) {
    const fr = await fetch(`${BRAIN}/api/frames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: visionUserId, frame: jpegB64 })
    })
    if (!fr.ok) throw new Error(`frames POST ${fr.status}`)
  }
  report('上传 2 帧红色图（每用户最近 2 帧）', true)

  const resC = await fetch(`${BRAIN}/api/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: visionUserId,
      sessionId: `vision-e2e-session-${Date.now()}`,
      text: '你现在看到的图片主色调是什么？简单回答。'
    })
  })
  let cnC = ''
  let errorC = ''
  if (resC.ok && resC.body) {
    const reader = resC.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              const ev = JSON.parse(payload)
              if (ev.type === 'delta') cnC += ev.delta
              if (ev.type === 'error') errorC = ev.message ?? ''
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  } else {
    errorC = `HTTP ${resC.status}`
  }
  report('视觉回合无错误', !errorC, errorC)
  const sawRed = /红|red/i.test(cnC)
  report('LLM 看到图片并回答主色（红）', sawRed, `cn=${cnC.slice(0, 80)}`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  cdp.close()
}
