import type { Db } from './db.ts'

export interface TurnMetricSource {
  sessionId: string
  userId: string
  channel: string
  startedAt: number
  model: string
  providerName?: string
  usage: { input: number; output: number; total: number }
  toolCalls: number
  toolNames: string[]
}

/**
 * 回合指标落库（看板数据源）。只看真实完成的回合：
 * token 来自 pi-ai 的 usage，没有 usage 就记 0，不估算。
 */
export async function recordTurnMetric(db: Db, input: TurnMetricSource): Promise<void> {
  try {
    await db.recordTurnMetric({
      sessionId: input.sessionId,
      userId: input.userId,
      channel: input.channel,
      model: input.model,
      provider: input.providerName ?? '',
      startedAt: input.startedAt,
      durationMs: Date.now() - input.startedAt,
      toolCalls: input.toolCalls,
      tools: input.toolNames,
      inputTokens: input.usage.input,
      outputTokens: input.usage.output,
      totalTokens: input.usage.total
    })
  } catch (error) {
    console.warn('[metrics] 回合指标写入失败：', error instanceof Error ? error.message : error)
  }
}
