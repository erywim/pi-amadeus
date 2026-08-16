import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { finishTurn, framesOf, resolveTarget, runVoiceTurn } from '../conversation.ts'
import { sseResponse } from '../sse.ts'

/**
 * 语音回合：POST /api/voice { userId, sessionId, text } → SSE
 * 事件：emotion（表情）/ delta（中文上屏）/ audio（base64 PCM 音频块）/ done / error。
 * 桌面 Live2D 页的调试输入框与麦克风 STT 结果都走这里（同一链路）。
 */
export function voiceRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  app.post('/voice', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; sessionId?: unknown; text?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!userId || !sessionId || !text) {
      return c.json({ error: 'userId/sessionId/text 必填' }, 400)
    }

    const frames = framesOf(userId)
    const ttsConfig = {
      apiKey: cfg.fish.apiKey,
      voice: cfg.fish.voice,
      model: cfg.fish.model,
      endpoint: cfg.fish.endpoint,
      sampleRate: cfg.fish.sampleRate,
      proxy: cfg.fish.proxy
    }

    return sseResponse(
      async function* (signal) {
        let cnFull = ''
        let jpFull = ''
        try {
          const stream = runVoiceTurn(
            { cfg, db, userId, sessionId, channel: 'desktop', mode: 'voice', content: text, frames },
            signal,
            ttsConfig
          )
          // 手动循环以拿到生成器返回值（解析出的 cn/jp 全文，用于落库）
          for (;;) {
            const r = await stream.next()
            if (r.done) {
              cnFull = r.value.cn
              jpFull = r.value.jp
              break
            }
            yield r.value
          }
        } catch (error) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('[voice] 语音回合失败：', message)
          yield { type: 'error', message }
          return
        }
        if (!cnFull) {
          yield { type: 'error', message: 'LLM 未产出有效回复' }
          return
        }
        const target = await resolveTarget(cfg, db, userId)
        const messageId = await finishTurn(db, {
          sessionId,
          userId,
          channel: 'desktop',
          mode: 'voice',
          content: cnFull,
          ttsText: jpFull || null,
          target,
          userText: text
        })
        yield { type: 'done', sessionId, messageId }
      },
      c.req.raw.signal
    )
  })

  return app
}
