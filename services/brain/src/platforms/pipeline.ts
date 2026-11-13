import type { PlatformInbound } from '@pi-amadeus/shared'
import { runAgentTurn, type AgentTurnResult } from '../agentTurn.ts'
import type { BrainConfig } from '../config.ts'
import { finishTurn } from '../conversation.ts'
import type { Db, PlatformRow } from '../db.ts'
import { prepareAttachments } from '../media.ts'
import { recordTurnMetric } from '../metrics.ts'
import type { SendOptions } from './types.ts'

/** 同一会话的回合串行执行：平台可能连发多条，不能让上下文交错 */
const sessionQueues = new Map<string, Promise<void>>()

async function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const previous = sessionQueues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  sessionQueues.set(
    key,
    next.catch(() => {})
  )
  try {
    await next
  } finally {
    if (sessionQueues.get(key) === next) sessionQueues.delete(key)
  }
}

/**
 * 平台消息共用的回合管线：绑定身份 → 共享会话 → agent 回合 → 落库/指标 → 回复。
 * 与桌面/飞书共用同一套 conversation/memory/metrics，平台只是另一个入口。
 */
export async function handlePlatformMessage(opts: {
  cfg: BrainConfig
  db: Db
  platform: PlatformRow
  inbound: PlatformInbound
  reply: (text: string, options?: SendOptions) => Promise<void>
}): Promise<void> {
  const { cfg, db, platform, inbound, reply } = opts
  const text = inbound.text.trim()
  const media = inbound.media ?? []
  if (!text && media.length === 0) return
  // 引用内容作为上下文前缀；回复时 adapter 会用 messageId 做真正的引用
  const content = inbound.quote ? `> 引用：${inbound.quote}\n\n${text}` : text
  const sessionId = `${platform.id}-${inbound.chatType}-${inbound.chatId}`

  // /bind <绑定码>：绑定外部账号；只允许私聊历史随身份迁移，群历史保持原 owner
  const bind = /^\/(?:bind|绑定)\s+(\S+)/i.exec(text)
  if (bind) {
    const code = bind[1]!
    const target = await db.findUserByBindCode(code)
    if (!target) {
      await reply('绑定码无效或已过期。请在桌面端「设置 → 飞书」生成绑定码后再试。')
      return
    }
    await enqueue(sessionId, async () => {
      await db.upsertPlatformAccount(platform.id, inbound.externalUserId, target.id)
      if (inbound.chatType === 'private') {
        // 私聊绑定在队列中迁移，避免前一回合把历史继续记到旧身份
        await db.reassignSession(sessionId, target.id)
      }
      await reply(`绑定成功，之后会以「${target.username}」的身份继续。`)
    })
    return
  }

  let attachments
  try {
    attachments = await prepareAttachments(
      cfg,
      media.map((item) => ({ name: item.name, mimeType: item.mimeType, data: item.data }))
    )
  } catch (error) {
    await reply(`附件处理失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  await enqueue(sessionId, async () => {
    const startedAt = Date.now()
    try {
      const user = await resolvePlatformUser(db, platform, inbound.externalUserId)
      const existingSession = await db.getSession(sessionId)
      // 群会话沿用首位 owner（含记忆/指标），换人或绑定都不能接管整群历史
      const userId = inbound.chatType === 'group' ? existingSession?.userId ?? user.id : user.id
      if (inbound.chatType === 'private' && existingSession && existingSession.userId !== userId) {
        // 私聊绑定后沿用新身份；不影响同一账号参加的群或其它人的私聊
        await db.reassignSession(sessionId, userId)
      }
      const run = runAgentTurn({
        cfg,
        db,
        userId,
        sessionId,
        channel: platform.kind,
        mode: 'text',
        content,
        attachments,
        signal: AbortSignal.timeout(300_000),
        temperature: 0.7
      })
      let full = ''
      let result: AgentTurnResult | null = null
      for (;;) {
        const step = await run.next()
        if (step.done) {
          result = step.value
          break
        }
        if (step.value.type === 'delta') full += step.value.delta
      }
      if (!result) return
      const turn = result
      full = turn.full || full
      if (!full) {
        await reply('……（这次没组织好语言，稍后再试）')
        return
      }
      await finishTurn(db, {
        sessionId,
        userId,
        channel: platform.kind,
        mode: 'text',
        content: full,
        ttsText: null,
        target: turn.target,
        userText: content || media.map((item) => item.name).join('、'),
        toolCalls: turn.toolCalls,
        ...(turn.thinking ? { thinking: turn.thinking } : {})
      })
      await recordTurnMetric(db, {
        sessionId,
        userId,
        channel: platform.kind,
        startedAt,
        model: turn.target.model,
        providerName: turn.target.providerName,
        providerId: turn.target.providerId,
        usage: turn.usage,
        toolCalls: turn.toolCalls,
        toolNames: turn.toolNames
      })
      await reply(full, inbound.messageId ? { replyTo: inbound.messageId } : undefined)
    } catch (error) {
      console.warn(
        `[platform:${platform.kind}] 回合失败：`,
        error instanceof Error ? error.message : error
      )
      await reply(
        '……（暂时连不上大脑，稍后再试）',
        inbound.messageId ? { replyTo: inbound.messageId } : undefined
      ).catch(() => {})
    }
  })
}

async function resolvePlatformUser(
  db: Db,
  platform: PlatformRow,
  externalUserId: string
): Promise<{ id: string; username: string }> {
  const account = await db.findPlatformAccount(platform.id, externalUserId)
  if (account) {
    const user = await db.getUser(account.userId)
    if (user) return { id: user.id, username: user.username }
  }
  const username = `${platform.kind}-${externalUserId}`
  const { id } = await db.resolveUser(username)
  return { id, username }
}
