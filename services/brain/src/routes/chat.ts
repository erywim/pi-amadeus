import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { runAgentTurn, type AgentTurnResult } from '../agentTurn.ts'
import { finishTurn } from '../conversation.ts'
import { sseResponse } from '../sse.ts'

/** 文本回合：POST /api/chat { userId, sessionId, content } → SSE delta / tool 事件 / done / error（仅中文） */
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

    return sseResponse(
      async function* (signal) {
        let full = ''
        let target: AgentTurnResult['target'] | null = null
        try {
          // 手动 next() 迭代：for await 会丢弃 generator 的 return 值
          const run = runAgentTurn({
            cfg,
            db,
            userId,
            sessionId,
            channel: 'desktop',
            mode: 'text',
            content,
            signal
          })
          let next = await run.next()
          while (!next.done) {
            yield next.value
            next = await run.next()
          }
          full = next.value.full
          target = next.value.target
        } catch (error) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('[chat] 工具回合失败：', message)
          yield { type: 'error', message }
          return
        }
        if (signal.aborted || !full || !target) {
          if (!signal.aborted && !full) yield { type: 'error', message: 'LLM 返回为空' }
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
