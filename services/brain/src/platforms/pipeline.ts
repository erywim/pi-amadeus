import type { PlatformInbound } from '@pi-amadeus/shared'
import { runAgentTurn, type AgentTurnResult } from '../agentTurn.ts'
import type { BrainConfig } from '../config.ts'
import { finishTurn } from '../conversation.ts'
import type { Db, PlatformRow } from '../db.ts'
import { recordTurnMetric } from '../metrics.ts'

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
  reply: (text: string) => Promise<void>
}): Promise<void> {
  const { cfg, db, platform, inbound, reply } = opts
  const text = inbound.text.trim()
  if (!text) return

  // /bind <绑定码>：把外部账号绑到桌面端用户，之后记忆与好感度都记在该用户上
  const bind = /^\/(?:bind|绑定)\s+(\S+)/i.exec(text)
  if (bind) {
    const code = bind[1]!
    const target = await db.findUserByBindCode(code)
    if (!target) {
      await reply('绑定码无效或已过期。请在桌面端「设置 → 飞书」生成绑定码后再试。')
      return
    }
    await db.upsertPlatformAccount(platform.id, inbound.externalUserId, target.id)
    await reply(`绑定成功，之后会以「${target.username}」的身份继续。`)
    return
  }

  const user = await resolvePlatformUser(db, platform, inbound.externalUserId)
  const sessionId = `${platform.id}-${inbound.chatType}-${inbound.chatId}`
  // 账号被 /bind 到桌面用户后，会话归属跟着转移：桌面端才能在列表里看到并继续这段对话
  const existingSession = await db.getSession(sessionId)
  if (existingSession && existingSession.userId !== user.id) {
    await db.reassignSession(sessionId, user.id)
  }

  await enqueue(sessionId, async () => {
    const startedAt = Date.now()
    try {
      const run = runAgentTurn({
        cfg,
        db,
        userId: user.id,
        sessionId,
        channel: platform.kind,
        mode: 'text',
        content: text,
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
        userId: user.id,
        channel: platform.kind,
        mode: 'text',
        content: full,
        ttsText: null,
        target: turn.target,
        userText: text,
        toolCalls: turn.toolCalls
      })
      await recordTurnMetric(db, {
        sessionId,
        userId: user.id,
        channel: platform.kind,
        startedAt,
        model: turn.target.model,
        providerName: turn.target.providerName,
        usage: turn.usage,
        toolCalls: turn.toolCalls,
        toolNames: turn.toolNames
      })
      await reply(full)
    } catch (error) {
      console.warn(
        `[platform:${platform.kind}] 回合失败：`,
        error instanceof Error ? error.message : error
      )
      await reply('……（暂时连不上大脑，稍后再试）').catch(() => {})
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
