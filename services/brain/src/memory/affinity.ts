import { affinityStageOf, type AffinityDailyPoint, type AffinitySummary } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'

/**
 * 好感度：只由真实发生过的互动事件累计，不读取任何外部输入。
 * 每个成功回合记一次；分值规则是确定性的，方便解释与复算。
 */

export interface TurnAffinityInput {
  userText: string
  assistantText: string
  toolCalls: number
}

export function affinityDeltaOf(input: TurnAffinityInput): { delta: number; reason: string } {
  const reasons: string[] = ['回合互动']
  let delta = 1
  if (input.userText.trim().length >= 20) {
    delta += 1
    reasons.push('认真倾诉')
  }
  if (input.assistantText.trim().length >= 80) {
    delta += 1
    reasons.push('深入交流')
  }
  if (input.toolCalls > 0) {
    delta += 1
    reasons.push('一起完成任务')
  }
  return { delta, reason: reasons.join(' · ') }
}

export async function recordAffinityTurn(
  db: Db,
  userId: string,
  input: TurnAffinityInput
): Promise<void> {
  const { delta, reason } = affinityDeltaOf(input)
  await db.addAffinityEvent({ userId, delta, reason })
}

/** 记忆提取成功后的额外好感（真实发生了「被记住」这件事） */
export async function recordMemoryAffinity(db: Db, userId: string): Promise<void> {
  await db.addAffinityEvent({ userId, delta: 2, reason: '记住了一件事' })
}

const DAY_MS = 86_400_000

export async function summarizeAffinity(db: Db, userId: string): Promise<AffinitySummary> {
  const events = await db.listAffinityEvents(userId)
  const score = events.reduce((sum, event) => sum + event.delta, 0)
  const stage = affinityStageOf(score)
  const since = events.length > 0 ? Math.min(...events.map((event) => event.createdAt)) : null

  const today = startOfDay(Date.now())
  const start = today - 13 * DAY_MS
  const inWindow = events.filter((event) => event.createdAt >= start)
  const beforeWindow = events
    .filter((event) => event.createdAt < start)
    .reduce((sum, event) => sum + event.delta, 0)
  const byDay = new Map<string, number>()
  for (const event of inWindow) {
    const key = dayKey(event.createdAt)
    byDay.set(key, (byDay.get(key) ?? 0) + event.delta)
  }
  const daily: AffinityDailyPoint[] = []
  let running = beforeWindow
  for (let index = 0; index < 14; index += 1) {
    const key = dayKey(start + index * DAY_MS)
    const delta = byDay.get(key) ?? 0
    running += delta
    daily.push({ day: key, score: running, delta })
  }

  return {
    score,
    stage: stage.stage,
    stageKey: stage.key,
    nextAt: stage.nextAt,
    events: events.slice(0, 20).map((event) => ({
      delta: event.delta,
      reason: event.reason,
      createdAt: event.createdAt
    })),
    daily,
    since
  }
}

function startOfDay(ts: number): number {
  const date = new Date(ts)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayKey(ts: number): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
