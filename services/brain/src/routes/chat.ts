import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { runAgentTurn, type AgentTurnResult } from '../agentTurn.ts'
import { finishTurn } from '../conversation.ts'
import { recordTurnMetric } from '../metrics.ts'
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
        const startedAt = Date.now()
        let full = ''
        let target: AgentTurnResult['target'] | null = null
        let result: AgentTurnResult | null = null
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
          result = next.value
          full = result.full
          target = result.target
        } catch (error) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('[chat] 工具回合失败：', message)
          yield { type: 'error', message }
          return
        }
        if (signal.aborted || !full || !target || !result) {
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
          userText: content,
          toolCalls: result.toolCalls
        })
        await recordTurnMetric(db, {
          sessionId,
          userId,
          channel: 'desktop',
          startedAt,
          model: result.target.model,
          providerName: result.target.providerName,
          usage: result.usage,
          toolCalls: result.toolCalls,
          toolNames: result.toolNames
        })
        yield {
          type: 'done',
          sessionId,
          messageId,
          ...(result.userMessageId ? { userMessageId: result.userMessageId } : {})
        }
      },
      c.req.raw.signal
    )
  })

  /**
   * 重新生成：对会话最后一条用户消息再跑一次，替换掉旧的助手回复。
   * - 会话末尾是助手回复 → 定位它前面那条用户消息，成功后替换旧回复
   * - 会话末尾是用户消息（上一回合失败/被停止）→ 直接重跑，不新增用户消息
   */
  app.post('/chat/regenerate', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; sessionId?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (!userId || !sessionId) {
      return c.json({ error: 'userId/sessionId 必填' }, 400)
    }
    // 归属校验：不能拿别人的 sessionId 触发重新生成（会读到别人的上下文）
    const session = await db.getSession(sessionId)
    if (!session || session.userId !== userId) {
      return c.json({ error: '会话不存在' }, 404)
    }

    const rows = await db.listMessages(sessionId, 40)
    const last = rows.at(-1)
    if (!last) return c.json({ error: '没有可重新生成的消息' }, 400)

    // 旧助手回复待替换；生成失败时保留原样（finishTurn 成功前不删除）
    const replaceMessageId = last.role === 'assistant' ? last.id : undefined
    const lastUser = [...rows].reverse().find((m) => m.role === 'user')
    if (!lastUser) return c.json({ error: '没有可重新生成的用户消息' }, 400)
    const userText = lastUser.content

    return sseResponse(
      async function* (signal) {
        const startedAt = Date.now()
        let full = ''
        let target: AgentTurnResult['target'] | null = null
        let result: AgentTurnResult | null = null
        try {
          const run = runAgentTurn({
            cfg,
            db,
            userId,
            sessionId,
            channel: 'desktop',
            mode: 'text',
            content: userText,
            signal,
            // 历史里已有这条用户消息；旧助手回复不进上下文
            appendUserMessage: false,
            omitMessageId: replaceMessageId
          })
          let next = await run.next()
          while (!next.done) {
            yield next.value
            next = await run.next()
          }
          result = next.value
          full = result.full
          target = result.target
        } catch (error) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('[chat] 重新生成失败：', message)
          yield { type: 'error', message }
          return
        }
        if (signal.aborted || !full || !target || !result) {
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
          userText,
          replaceMessageId,
          toolCalls: result.toolCalls
        })
        await recordTurnMetric(db, {
          sessionId,
          userId,
          channel: 'desktop',
          startedAt,
          model: result.target.model,
          providerName: result.target.providerName,
          usage: result.usage,
          toolCalls: result.toolCalls,
          toolNames: result.toolNames
        })
        yield { type: 'done', sessionId, messageId }
      },
      c.req.raw.signal
    )
  })

  /**
   * 编辑用户消息并重发：改正文 → 截断该消息之后的所有消息 → 以编辑后的内容重跑。
   * 这是 LibreChat 式「编辑后重发」：之后的分支内容会被丢弃，界面对应截断。
   */
  app.post('/chat/edit', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; sessionId?: unknown; messageId?: unknown; content?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!userId || !sessionId || !messageId || !content) {
      return c.json({ error: 'userId/sessionId/messageId/content 必填' }, 400)
    }
    if (content.length > 20_000) return c.json({ error: '消息过长（上限 20000 字）' }, 400)

    const session = await db.getSession(sessionId)
    if (!session || session.userId !== userId) return c.json({ error: '会话不存在' }, 404)
    const rows = await db.listMessages(sessionId, 400)
    const target = rows.find((row) => row.id === messageId)
    if (!target) return c.json({ error: '消息不存在' }, 404)
    if (target.role !== 'user') return c.json({ error: '只能编辑用户消息' }, 400)

    // 截断与改写都发生在流开始之前：即使模型随后失败，会话也停在「等待回答」的状态，
    // 用户可以重试，不会留下半截旧分支
    await db.updateMessageContent(messageId, content)
    await db.deleteMessagesAfter(sessionId, messageId)

    return sseResponse(
      async function* (signal) {
        const startedAt = Date.now()
        let full = ''
        let target2: AgentTurnResult['target'] | null = null
        let result: AgentTurnResult | null = null
        try {
          const run = runAgentTurn({
            cfg,
            db,
            userId,
            sessionId,
            channel: 'desktop',
            mode: 'text',
            content,
            signal,
            // 编辑后的用户消息已经在历史里，不能再写一条
            appendUserMessage: false
          })
          let next = await run.next()
          while (!next.done) {
            yield next.value
            next = await run.next()
          }
          result = next.value
          full = result.full
          target2 = result.target
        } catch (error) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('[chat] 编辑重发失败：', message)
          yield { type: 'error', message }
          return
        }
        if (signal.aborted || !full || !target2 || !result) {
          if (!signal.aborted && !full) yield { type: 'error', message: 'LLM 返回为空' }
          return
        }
        const messageId2 = await finishTurn(db, {
          sessionId,
          userId,
          channel: 'desktop',
          mode: 'text',
          content: full,
          ttsText: null,
          target: target2,
          userText: content,
          toolCalls: result.toolCalls
        })
        await recordTurnMetric(db, {
          sessionId,
          userId,
          channel: 'desktop',
          startedAt,
          model: result.target.model,
          providerName: result.target.providerName,
          usage: result.usage,
          toolCalls: result.toolCalls,
          toolNames: result.toolNames
        })
        yield { type: 'done', sessionId, messageId: messageId2 }
      },
      c.req.raw.signal
    )
  })

  return app
}
