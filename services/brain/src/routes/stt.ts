import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import { pcmToWav, transcribe } from '../stt.ts'

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
