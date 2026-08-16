/** 只跑视觉回合（phase C）：配 vision 用户 → 传帧 → 语音回合 → 打印 SSE 结果 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BRAIN = 'http://localhost:3002'
const CDP_HTTP = 'http://127.0.0.1:9222'
const envPath = resolve(import.meta.dirname, '../services/brain/.env')
const whisperKey = readFileSync(envPath, 'utf8')
  .split('\n')
  .find((l) => l.startsWith('WHISPER_API_KEY='))
  .slice('WHISPER_API_KEY='.length)
  .trim()

// 页面 canvas 红色 JPEG
const res = await fetch(`${CDP_HTTP}/json/list`)
const targets = await res.json()
const target = targets.find((t) => t.type === 'page')
const jpegB64 = await new Promise((resolveP, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => {
            const c = document.createElement('canvas'); c.width = 320; c.height = 240;
            const x = c.getContext('2d');
            x.fillStyle = '#cc0000'; x.fillRect(0, 0, 320, 240);
            x.fillStyle = '#ffffff'; x.beginPath(); x.arc(160, 120, 50, 0, Math.PI * 2); x.fill();
            return c.toDataURL('image/jpeg', 0.8).split(',')[1];
          })()`,
          awaitPromise: true,
          returnByValue: true
        }
      })
    )
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id === 1) {
      ws.close()
      resolveP(msg.result.result.value)
    }
  }
  ws.onerror = (e) => reject(new Error(`CDP 失败: ${e.message}`))
})

const uidRes = await fetch(`${BRAIN}/api/users/resolve`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'vision-e2e-user' })
})
const visionUserId = (await uidRes.json()).userId
console.log('visionUserId:', visionUserId)

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
console.log('PUT config:', cfgRes.status, await cfgRes.text())
const got = await fetch(`${BRAIN}/api/config/${visionUserId}`)
console.log('GET config:', got.status, await got.text())

for (let i = 0; i < 2; i++) {
  const fr = await fetch(`${BRAIN}/api/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: visionUserId, frame: jpegB64 })
  })
  console.log(`frames POST #${i}:`, fr.status)
}

const vres = await fetch(`${BRAIN}/api/voice`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: visionUserId,
    sessionId: `vision-debug-session-${Date.now()}`,
    text: '你现在看到的图片主色调是什么？简单回答。'
  })
})
const reader = vres.body.getReader()
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
    if (line.startsWith('data:')) console.log(line.slice(5).trim())
  }
}
