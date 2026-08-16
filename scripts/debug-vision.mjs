/**
 * 视觉调试：直接向 aihubmix 发 chat.completions（走 Clash 代理），
 * 对比 (a) 页面 canvas 生成的红色 JPEG（与 e2e-vision 完全同路径）
 *       (b) Node zlib 生成的纯红 PNG
 * 看 gpt-4o-mini 到底能不能看到图。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import zlib from 'node:zlib'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const CDP_HTTP = 'http://127.0.0.1:9222'
const envPath = resolve(import.meta.dirname, '../services/brain/.env')
const key = readFileSync(envPath, 'utf8')
  .split('\n')
  .find((l) => l.startsWith('WHISPER_API_KEY='))
  .slice('WHISPER_API_KEY='.length)
  .trim()

// ---------- 纯红 PNG（Node 端生成，zlib 手写 PNG 编码） ----------
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function redPng(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const rows = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1)
    rows[off] = 0 // filter none
    for (let x = 0; x < w; x++) {
      rows[off + 1 + x * 3] = 204 // R
      rows[off + 2 + x * 3] = 0 // G
      rows[off + 3 + x * 3] = 0 // B
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 从 Electron 页面取红色 JPEG（与 E2E 同路径） ----------
async function getPageJpeg() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  return new Promise((resolveP, reject) => {
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
}

async function askAiHub(imageB64, mime, label) {
  const agent = new ProxyAgent('http://127.0.0.1:7890')
  const res = await undiciFetch('https://aihubmix.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    dispatcher: agent,
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请只回答：这张图片的主色调是什么？' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}` } }
          ]
        }
      ]
    })
  })
  const data = await res.json()
  const reply = data?.choices?.[0]?.message?.content
  console.log(`--- ${label} (HTTP ${res.status}) ---`)
  if (!reply) console.log(JSON.stringify(data).slice(0, 400))
  else console.log(reply)
}

console.log('== aihubmix gpt-4o-mini 视觉直测（Clash 代理） ==')
const jpegB64 = await getPageJpeg()
console.log(`页面 JPEG base64 长度: ${jpegB64.length}`)
await askAiHub(jpegB64, 'image/jpeg', '页面 canvas 红色 JPEG')
const png = redPng(64, 64)
await askAiHub(png.toString('base64'), 'image/png', 'Node 生成 64x64 纯红 PNG')
