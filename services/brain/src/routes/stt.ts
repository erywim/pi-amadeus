import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import { pcmToWav, transcribe } from '../stt.ts'

/**
 * 单段语音解码后字节数上限。客户端 VAD 切段无最大时长（静音约 0.26s 收尾，
 * apps/desktop src/renderer/src/lib/vad.ts），采样固定 16kHz / 16bit / 单声道
 * （voice.ts RECORD_SAMPLE_RATE，≈32000 字节/秒），且 floatToWavBase64 已带 44 字节 WAV 头。
 * 对话语音通常是秒级，上限取 5 分钟（≈9.6MB），余量充足且低于 Whisper 25MB 上限，挡住灌水请求。
 */
const MAX_PCM_BYTES = 5 * 60 * 32000 + 44

/** 严格 base64 字符集/填充形态（与 frames.ts 同口径：扁平字符类，避免长串上嵌套量词回溯溢出） */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** N 字节二进制对应的 base64 最大长度（含填充余量） */
const MAX_PCM_BASE64_LENGTH = Math.ceil(MAX_PCM_BYTES / 3) * 4 + 4

/** STT：POST /api/stt { pcmBase64, sampleRate } → { text }（前端 VAD 切出的语音段） */
export function sttRoutes(cfg: BrainConfig): Hono {
  const app = new Hono()

  app.post('/stt', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { pcmBase64?: unknown; sampleRate?: unknown }
      | null
    const pcmBase64 = typeof body?.pcmBase64 === 'string' ? body.pcmBase64 : ''
    const sampleRate = typeof body?.sampleRate === 'number' ? body.sampleRate : 16000
    if (!pcmBase64) return c.json({ error: 'pcmBase64 必填' }, 400)
    // 先按编码长度挡超大段（避免无谓解码），再做严格形态校验与解码后长度检查（防止把灌水/垃圾数据转发到 Whisper）
    if (pcmBase64.length > MAX_PCM_BASE64_LENGTH) {
      return c.json({ error: 'pcmBase64 超出大小上限' }, 400)
    }
    if (!STRICT_BASE64_RE.test(pcmBase64) || pcmBase64.length % 4 !== 0) {
      return c.json({ error: 'pcmBase64 不是合法 base64' }, 400)
    }
    if (Buffer.from(pcmBase64, 'base64').length > MAX_PCM_BYTES) {
      return c.json({ error: 'pcmBase64 超出大小上限' }, 400)
    }
    if (!cfg.whisper.apiKey || !cfg.whisper.baseUrl) {
      return c.json({ error: 'Whisper 未配置' }, 503)
    }

    try {
      const pcm = Buffer.from(pcmBase64, 'base64')
      const wav = pcmToWav(pcm, sampleRate)
      const text = await transcribe(wav, {
        apiKey: cfg.whisper.apiKey,
        baseUrl: cfg.whisper.baseUrl,
        model: cfg.whisper.model,
        proxy: cfg.whisper.proxy
      })
      return c.json({ text })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[stt] 转写失败：', message)
      return c.json({ error: message }, 502)
    }
  })

  return app
}
