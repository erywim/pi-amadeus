import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { finishTurn, prepareTurn } from '../conversation.ts'
import { streamText } from '../llm.ts'
import { sseResponse } from '../sse.ts'

/** 文本回合：POST /api/chat { userId, sessionId, content } → SSE delta/done/error（仅中文） */
export function chatRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  app.post('/chat', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; sessionId?: unknown; content?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!userId || !sessionId || !content) {
      return c.json({ error: 'userId/sessionId/content 必填' }, 400)
    }

    const turn = prepareTurn({ cfg, db, userId, sessionId, channel: 'desktop', mode: 'text', content })

    return sseResponse(
      async function* (signal) {
        const { target, systemPrompt, messages } = await turn
        let full = ''
        try {
          for await (const delta of streamText(target, { systemPrompt, messages }, { signal })) {
            full += delta
            yield { type: 'delta', delta }
          }
        } catch (error) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('[chat] LLM 流失败：', message)
          yield { type: 'error', message }
          return
        }
        if (!full) {
          yield { type: 'error', message: 'LLM 返回为空' }
          return
        }
        const messageId = await finishTurn(db, {
          sessionId,
          userId,
          channel: 'desktop',
          mode: 'text',
          content: full,
          ttsText: null,
          target,
          userText: content
        })
        yield { type: 'done', sessionId, messageId }
      },
      c.req.raw.signal
    )
  })

  return app
}
