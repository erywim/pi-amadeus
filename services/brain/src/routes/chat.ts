import { Hono } from 'hono'
import type { AttachmentPayload } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { agentTurnErrorInfo, runAgentTurn, type AgentTurnResult } from '../agentTurn.ts'
import { finishTurn } from '../conversation.ts'
import { copyAttachments, prepareAttachments, removeAttachmentCopies, type SavedAttachment } from '../media.ts'
import { recordTurnMetric } from '../metrics.ts'
import { sseResponse } from '../sse.ts'

/** 文本回合：POST /api/chat { userId, sessionId, content } → SSE delta / tool 事件 / done / error（仅中文） */
export function chatRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  app.post('/chat', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; sessionId?: unknown; content?: unknown; attachments?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    const attachmentInputs: AttachmentPayload[] = []
    if (Array.isArray(body?.attachments)) {
      for (const item of body.attachments) {
        if (!item || typeof item !== 'object') continue
        const value = item as Record<string, unknown>
        if (
          typeof value.name === 'string' &&
          typeof value.mimeType === 'string' &&
          typeof value.data === 'string'
        ) {
          attachmentInputs.push({
            name: value.name,
            mimeType: value.mimeType,
            data: value.data
          })
        }
      }
    }
    if (!userId || !sessionId || (!content && attachmentInputs.length === 0)) {
      return c.json({ error: 'userId/sessionId 必填，且至少要有文字或附件' }, 400)
    }

    let attachments: SavedAttachment[]
    try {
      attachments = await prepareAttachments(cfg, attachmentInputs)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
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
            attachments,
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
          const info = agentTurnErrorInfo(error)
          console.error('[chat] 工具回合失败：', message, info)
          yield { type: 'error', message, code: info.code, recoverability: info.recoverability, ...(info.details ? { details: info.details } : {}) }
          return
        }
        if (signal.aborted || !full || !target || !result) {
          if (!signal.aborted && !full) yield { type: 'error', message: 'LLM 返回为空', code: 'provider_error', recoverability: 'retry' }
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
          userText: content || attachments.map((item) => item.name).join('、'),
          userMessageId: result.userMessageId,
          toolCalls: result.toolCalls,
          changedFiles: result.changedFiles,
          thinking: result.thinking
        })
        await recordTurnMetric(db, {
          sessionId,
          userId,
          channel: 'desktop',
          startedAt,
          model: result.target.model,
          providerName: result.target.providerName,
        providerId: result.target.providerId,
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
   * 重新生成：对当前分支最后一条用户消息再跑一次，新回复成为该用户消息的
   * 另一个子节点（旧回复保留，可在分支切换器里回看）。
   * - 分支末尾是助手回复 → 以它的父用户消息为上下文
   * - 分支末尾是用户消息（上一回合失败/被停止）→ 直接重跑
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

    // 旧助手回复保留在旧分支；新回复挂到同一条用户消息下
    const oldAssistantId = last.role === 'assistant' ? last.id : undefined
    const lastUser =
      last.role === 'user'
        ? last
        : rows.find((message) => message.id === last.parentId && message.role === 'user') ??
          [...rows].reverse().find((message) => message.role === 'user')
    if (!lastUser) return c.json({ error: '没有可重新生成的用户消息' }, 400)
    const userText = lastUser.content
    if (last.role === 'assistant') {
      // 活动叶退回到产生旧回复的那条用户消息；否则新回复会挂在旧回复下面成一条链
      await db.setActiveLeaf(sessionId, lastUser.id)
      await db.clearCompaction(sessionId)
    }

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
            attachments: lastUser.attachments,
            signal,
            // 历史里已有这条用户消息；旧助手回复不进上下文
            appendUserMessage: false,
            omitMessageId: oldAssistantId
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
          const info = agentTurnErrorInfo(error)
          console.error('[chat] 重新生成失败：', message, info)
          yield { type: 'error', message, code: info.code, recoverability: info.recoverability, ...(info.details ? { details: info.details } : {}) }
          return
        }
        if (signal.aborted || !full || !target || !result) {
          if (!signal.aborted && !full) yield { type: 'error', message: 'LLM 返回为空', code: 'provider_error', recoverability: 'retry' }
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
          parentMessageId: lastUser.id,
          toolCalls: result.toolCalls,
          changedFiles: result.changedFiles,
          thinking: result.thinking
        })
        await recordTurnMetric(db, {
          sessionId,
          userId,
          channel: 'desktop',
          startedAt,
          model: result.target.model,
          providerName: result.target.providerName,
        providerId: result.target.providerId,
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
   * 编辑用户消息并重发（分支树版）：
   * 新用户消息挂在原消息的父节点下，成为原消息的兄弟分支；旧消息与其回复保留。
   * 界面上表现为新分支成为当前路径，旧分支可通过分支切换器回看。
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
    const target = await db.getMessage(messageId)
    if (!target || target.sessionId !== sessionId) return c.json({ error: '消息不存在' }, 404)
    if (target.role !== 'user') return c.json({ error: '只能编辑用户消息' }, 400)
    const branchParentId = target.parentId

    return sseResponse(
      async function* (signal) {
        const startedAt = Date.now()
        let full = ''
        let target2: AgentTurnResult['target'] | null = null
        let result: AgentTurnResult | null = null
        let attachments: SavedAttachment[] = []
        let committed = false
        let messageId2 = ''
        try {
          attachments = copyAttachments(target.attachments, cfg.media.dir)
          const run = runAgentTurn({
            cfg,
            db,
            userId,
            sessionId,
            channel: 'desktop',
            mode: 'text',
            content,
            signal,
            attachments,
            // 新分支先只准备上下文；模型成功后再提交用户节点与附件
            appendUserMessage: true,
            branchParentId
          })
          let next = await run.next()
          while (!next.done) {
            yield next.value
            next = await run.next()
          }
          result = next.value
          full = result.full
          target2 = result.target
          if (signal.aborted || !full || !target2 || !result.userMessageId) {
            if (!signal.aborted && !full) yield { type: 'error', message: 'LLM 返回为空', code: 'provider_error', recoverability: 'retry' }
            return
          }
          const userMessageId = result.userMessageId
          const previousLeaf = await db.getActiveLeafId(sessionId)
          try {
            // 成功才从旧路径切到编辑分支；用户与回复共用本轮预留的父节点 ID
            await db.appendMessage({
              id: result.userMessageId, sessionId, role: 'user', content, mode: 'text', parentId: branchParentId
            })
            await db.addMessageMedia(result.userMessageId, attachments)
            messageId2 = await finishTurn(db, {
              sessionId,
              userId,
              channel: 'desktop',
              mode: 'text',
              content: full,
              ttsText: null,
              target: target2,
              userText: content,
              parentMessageId: result.userMessageId,
              toolCalls: result.toolCalls,
              changedFiles: result.changedFiles,
              thinking: result.thinking
            })
            committed = true
          } catch (error) {
            const pending = (await db.listAllMessages(sessionId)).filter((item) => item.parentId === userMessageId)
            for (const item of pending) await db.deleteMessage(item.id)
            await db.deleteMessage(userMessageId)
            if (previousLeaf) await db.setActiveLeaf(sessionId, previousLeaf)
            throw error
          }
        } catch (error) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          const info = agentTurnErrorInfo(error)
          console.error('[chat] 编辑重发失败：', message, info)
          yield { type: 'error', message, code: info.code, recoverability: info.recoverability, ...(info.details ? { details: info.details } : {}) }
          return
        } finally {
          // 失败/取消尚未提交的编辑只清副本；旧分支、原附件始终不动
          if (!committed) removeAttachmentCopies(attachments)
        }
        await recordTurnMetric(db, {
          sessionId,
          userId,
          channel: 'desktop',
          startedAt,
          model: result.target.model,
          providerName: result.target.providerName,
        providerId: result.target.providerId,
          usage: result.usage,
          toolCalls: result.toolCalls,
          toolNames: result.toolNames
        })
        yield {
          type: 'done',
          sessionId,
          messageId: messageId2,
          ...(result.userMessageId ? { userMessageId: result.userMessageId } : {})
        }
      },
      c.req.raw.signal
    )
  })

  return app
}
