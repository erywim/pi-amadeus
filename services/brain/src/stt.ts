import { ProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * STT：OpenAI 兼容的 Whisper HTTP 接口（aihubmix 等中转）。
 * 前端把语音段封装成 WAV 上传，服务端转发到 /audio/transcriptions。
 * aihubmix 国内直连不通，与 TTS 一样可走本地 HTTP 代理。
 */
export interface SttOptions {
  apiKey: string
  baseUrl: string
  model: string
  proxy?: string
}

export async function transcribe(wav: Buffer, opts: SttOptions): Promise<string> {
  const base = opts.baseUrl.replace(/\/+$/, '')
  // 手动构造 multipart/form-data（undici FormData 经中转服务偶发丢 boundary 头 → 415）
  const boundary = `----amadeus-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    'utf8'
  )
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${opts.model}\r\n--${boundary}--\r\n`,
    'utf8'
  )
  const res = await undiciFetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: Buffer.concat([head, wav, tail]),
    dispatcher: opts.proxy ? new ProxyAgent(opts.proxy) : undefined
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Whisper STT ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { text?: string }
  return (json.text ?? '').trim()
}

/** PCM s16le → WAV 封装（前端直传 PCM 亦可，此处统一转 WAV 便于调试） */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
