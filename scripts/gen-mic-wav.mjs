/**
 * 生成麦克风 E2E 输入音频 .tmp-mic-test.wav：
 * fish.audio TTS（32kHz PCM）→ 降采样 16kHz 单声道 → 尾部加 ~0.6s 静音
 * （静音尾让 silero 在停止录音后自然收段，覆盖"无 stop 的自然段结束"路径）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const envPath = resolve(import.meta.dirname, '../services/brain/.env')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)

const TEXT = '今日はいい天気ですね。'
const res = await undiciFetch(env.TTS_ENDPOINT_URL ?? 'https://api.fish.audio/v1/tts', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.FISH_AUDIO_API_KEY}`,
    'Content-Type': 'application/json',
    model: env.TTS_MODEL ?? 's2.1-pro'
  },
  body: JSON.stringify({
    text: TEXT,
    reference_id: env.FISH_AUDIO_VOICE,
    format: 'pcm',
    sample_rate: 32000,
    latency: 'normal'
  }),
  dispatcher: env.FISH_AUDIO_PROXY ? new ProxyAgent(env.FISH_AUDIO_PROXY) : undefined
})
if (!res.ok) {
  console.error(`fish.audio TTS ${res.status}:`, (await res.text()).slice(0, 200))
  process.exit(1)
}
const chunks = []
for await (const chunk of res.body) chunks.push(Buffer.from(chunk))
const pcm32 = Buffer.concat(chunks)
console.log(`TTS PCM: ${pcm32.length} bytes @32kHz (${(pcm32.length / 2 / 32000).toFixed(2)}s)`)

// 32k → 16k 降采样（取偶数样本）
const n16 = Math.floor(pcm32.length / 4)
const pcm16 = Buffer.alloc(n16 * 2)
for (let i = 0; i < n16; i++) pcm16.writeInt16LE(pcm32.readInt16LE(i * 4), i * 2)
// 尾部 0.6s 静音
const silence = Buffer.alloc(Math.round(16000 * 0.6) * 2)
const body = Buffer.concat([pcm16, silence])

const wav = Buffer.alloc(44)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + body.length, 4)
wav.write('WAVE', 8)
wav.write('fmt ', 12)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20) // PCM
wav.writeUInt16LE(1, 22) // mono
wav.writeUInt32LE(16000, 24)
wav.writeUInt32LE(16000 * 2, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(body.length, 40)

const out = resolve(import.meta.dirname, '../.tmp-mic-test.wav')
writeFileSync(out, Buffer.concat([wav, body]))
console.log(`写入 ${out}（${36 + 44 + body.length} 字节，含 0.6s 静音尾）`)
