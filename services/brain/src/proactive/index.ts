import { randomUUID } from 'node:crypto'
import type { ProactiveGreeting, ProactiveSettings } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import { resolveTarget } from '../conversation.ts'
import type { Db } from '../db.ts'
import { completeText } from '../llm.ts'
import { memorySystemPrompt, recallMemories, summarizeAffinity } from '../memory/index.ts'
import { buildSystemPrompt } from '../persona.ts'

/**
 * 主动问候：只有「真实空闲 + 真实时间窗 + 真实模型」三者都满足才发。
 * 消息作为助手消息落进用户最近的桌面会话，记忆/好感度注入 system prompt；
 * 不发固定模板、不伪造用户说过的话。
 */
const inFlight = new Set<string>()
const failureBackoff = new Map<string, number>()

function startOfToday(): number {
  const date = new Date()
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function minutesOf(hhmm: string): number {
  const [hour, minute] = hhmm.split(':')
  return Math.min(23, Math.max(0, Number(hour) || 0)) * 60 + Math.min(59, Math.max(0, Number(minute) || 0))
}

function inActiveWindow(now: Date, start: string, end: string): boolean {
  const current = now.getHours() * 60 + now.getMinutes()
  const from = minutesOf(start)
  const to = minutesOf(end)
  if (from === to) return true
  // 跨午夜窗口（如 22:00–02:00）
  return from < to ? current >= from && current < to : current >= from || current < to
}

function timeLabel(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

export async function generateProactiveGreeting(
  cfg: BrainConfig,
  db: Db,
  userId: string,
  opts?: { force?: boolean }
): Promise<ProactiveGreeting | null> {
  if (inFlight.has(userId)) return null
  const settings = await db.getProactiveSettings(userId)
  if (!settings.enabled && !opts?.force) return null
  const now = Date.now()
  const lastUser = await db.lastUserMessageAt(userId)
  const idleMinutes = lastUser ? Math.floor((now - lastUser) / 60_000) : null
  if (!opts?.force) {
    if (idleMinutes === null || idleMinutes < settings.minIdleMinutes) return null
    if (!inActiveWindow(new Date(now), settings.activeStart, settings.activeEnd)) return null
    const todayCount = await db.countProactiveToday(userId, startOfToday())
    if (todayCount >= settings.maxPerDay) return null
    if (
      settings.lastGreetedAt &&
      now - settings.lastGreetedAt < settings.minIdleMinutes * 60_000
    ) {
      return null
    }
    const failedAt = failureBackoff.get(userId)
    if (failedAt && now - failedAt < 10 * 60_000) return null
  }

  inFlight.add(userId)
  try {
    const target = await resolveTarget(cfg, db, userId, 'chat')
    const [userConfig, memories, affinity, latest] = await Promise.all([
      db.getUserConfig(userId),
      recallMemories(db, userId, '近况 心情 生活 工作'),
      summarizeAffinity(db, userId),
      db.latestProactiveGreeting(userId)
    ])
    const systemPrompt =
      buildSystemPrompt(userConfig?.systemPrompt, 'text') + memorySystemPrompt(memories, affinity)
    const idleText =
      idleMinutes === null
        ? '你还不了解用户'
        : `用户已经 ${idleMinutes} 分钟没有说话了`
    const prompt = [
      `现在是 ${timeLabel(new Date(now))}。${idleText}。`,
      '请以你的角色身份主动发一条 1~2 句的问候或关心。',
      '要求：自然、具体、像真的在想对方；不要提“系统/定时/自动/监测”，不要重复上一条，不要问“有什么可以帮你”。',
      latest ? `上一条主动问候是：「${latest.content}」，这次换个说法。` : ''
    ]
      .filter(Boolean)
      .join('\n')
    const content = (
      await completeText(
        target,
        {
          systemPrompt,
          messages: [{ role: 'user', content: prompt, timestamp: now }]
        },
        { maxTokens: 220, temperature: 0.85, thinkingLevel: 'off' }
      )
    ).trim()
    if (!content) return null

    // 问候只进入最近活跃且未归档的桌面会话，不能因置顶顺序唤回旧会话
    const sessions = await db.listSessions(userId)
    const session = sessions
      .filter((item) => item.channel === 'desktop' && !item.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    const fallbackId = `proactive-${userId}`
    // 原问候会话已归档时新建，归档不能被下一次问候隐式撤销
    const sessionId = session?.id ?? (sessions.some((item) => item.id === fallbackId)
      ? `${fallbackId}-${randomUUID()}`
      : fallbackId)
    await db.touchSession({ id: sessionId, userId, channel: 'desktop' })
    const messageId = randomUUID()
    await db.appendMessage({
      id: messageId,
      sessionId,
      role: 'assistant',
      content,
      mode: 'text'
    })
    if (!session?.title) await db.setSessionTitle(sessionId, '主动问候')
    const greeting = await db.addProactiveGreeting({
      userId,
      sessionId,
      messageId,
      content
    })
    await db.updateProactiveSettings(userId, { lastGreetedAt: Date.now() })
    failureBackoff.delete(userId)
    return greeting
  } catch (error) {
    failureBackoff.set(userId, Date.now())
    console.warn(
      '[proactive] 主动问候生成失败：',
      error instanceof Error ? error.message : error
    )
    return null
  } finally {
    inFlight.delete(userId)
  }
}

/** 每 60 秒检查一次；空闲判断与时间窗都在 generate 内，调度器只负责遍历 */
class ProactiveScheduler {
  private cfg: BrainConfig | null = null
  private db: Db | null = null
  private timer: NodeJS.Timeout | null = null

  init(cfg: BrainConfig, db: Db): void {
    this.cfg = cfg
    this.db = db
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runNow(userId: string): Promise<ProactiveGreeting | null> {
    if (!this.cfg || !this.db) return null
    return generateProactiveGreeting(this.cfg, this.db, userId, { force: true })
  }

  private async tick(): Promise<void> {
    if (!this.cfg || !this.db) return
    try {
      const users = await this.db.listProactiveUsers()
      for (const userId of users) {
        await generateProactiveGreeting(this.cfg, this.db, userId)
      }
    } catch (error) {
      console.warn(
        '[proactive] 调度失败：',
        error instanceof Error ? error.message : error
      )
    }
  }
}

export const proactiveScheduler = new ProactiveScheduler()

export type { ProactiveSettings }
