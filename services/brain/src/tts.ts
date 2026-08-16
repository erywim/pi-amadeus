// 用 npm undici 自带的 fetch 与 ProxyAgent 配对（内置 fetch 的 undici 管线
// 与独立包版本签名不一致，混用会报 invalid onRequestStart）
import { ProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * fish.audio TTS 代理：
 * POST {endpoint}/v1/tts，body { text, reference_id, format:'pcm', sample_rate, latency }，
 * header 带 model 引擎（s2.1-pro）。响应为裸 16bit 单声道 PCM 字节流，
 * 逐块透传（前端转 AudioBuffer 播放 + 幅度驱动口型）。
 * fish.audio 国内直连不通，可配置 proxy（如 Clash 127.0.0.1:7890）走 CONNECT 隧道。
 */
export interface TtsOptions {
  apiKey: string
  voice: string
  model: string
  endpoint: string
  sampleRate?: number
  signal?: AbortSignal
  /** HTTP 代理地址（如 http://127.0.0.1:7890），未配置则直连 */
  proxy?: string
}

export async function* ttsPcmStream(text: string, opts: TtsOptions): AsyncGenerator<Buffer> {
  const res = await undiciFetch(opts.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      model: opts.model
    },
    body: JSON.stringify({
      text,
      reference_id: opts.voice,
      format: 'pcm',
      sample_rate: opts.sampleRate ?? 32000,
      latency: 'normal'
    }),
    signal: opts.signal,
    dispatcher: opts.proxy ? new ProxyAgent(opts.proxy) : undefined
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`fish.audio TTS ${res.status}: ${body.slice(0, 200)}`)
  }
  if (!res.body) throw new Error('fish.audio TTS: 空响应体')
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) yield Buffer.from(value)
  }
}
