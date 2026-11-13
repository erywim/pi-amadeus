import { Hono } from 'hono'
import type { PluginKind, StatsDayPoint, StatsResponse } from '@pi-amadeus/shared'
import { PLUGIN_KINDS } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'
import { summarizeAffinity } from '../memory/index.ts'

/**
 * 数据看板：会话/消息总量、最近 N 天的回合与 token 趋势、渠道/模型/工具分布、插件统计。
 * 指标来自 turn_metrics（本轮改动之后产生的回合开始记录；历史回合没有指标，不回溯伪造）。
 */
export function statsRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/stats', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const rawDays = Number(c.req.query('days') ?? '14')
    const days = Number.isFinite(rawDays) ? Math.min(90, Math.max(7, Math.floor(rawDays))) : 14

    const sessions = await db.listSessions(userId)
    const messageCount = sessions.reduce((sum, session) => sum + (session.messageCount ?? 0), 0)

    const dayKeys = buildDayKeys(days)
    const sinceMs = startOfDay(Date.now() - (days - 1) * 86_400_000)
    const metrics = await db.listTurnMetrics(userId, sinceMs)

    const series = new Map<string, StatsDayPoint>(
      dayKeys.map((day) => [day, { day, turns: 0, toolCalls: 0, tokens: 0 }])
    )
    const modelMap = new Map<string, { model: string; turns: number; tokens: number }>()
    const providerMap = new Map<string, { name: string; turns: number; tokens: number }>()
    const toolMap = new Map<string, number>()
    let toolCalls = 0
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0

    for (const metric of metrics) {
      const point = series.get(dayKey(metric.startedAt))
      if (point) {
        point.turns += 1
        point.toolCalls += metric.toolCalls
        point.tokens += metric.totalTokens
      }
      toolCalls += metric.toolCalls
      inputTokens += metric.inputTokens
      outputTokens += metric.outputTokens
      totalTokens += metric.totalTokens
      const model = modelMap.get(metric.model) ?? { model: metric.model, turns: 0, tokens: 0 }
      model.turns += 1
      model.tokens += metric.totalTokens
      modelMap.set(metric.model, model)
      if (metric.provider) {
        const provider = providerMap.get(metric.provider) ?? {
          name: metric.provider,
          turns: 0,
          tokens: 0
        }
        provider.turns += 1
        provider.tokens += metric.totalTokens
        providerMap.set(metric.provider, provider)
      }
      for (const tool of metric.tools) {
        toolMap.set(tool, (toolMap.get(tool) ?? 0) + 1)
      }
    }

    const channelMap = new Map<string, number>()
    for (const session of sessions) {
      channelMap.set(session.channel, (channelMap.get(session.channel) ?? 0) + 1)
    }

    const plugins = await db.listPlugins()
    const byKind = Object.fromEntries(PLUGIN_KINDS.map((kind) => [kind, 0])) as Record<PluginKind, number>
    for (const plugin of plugins) byKind[plugin.kind] += 1

    // 记忆与好感度同样来自真实数据：没有记录就是 0
    const [memoryCount, affinity] = await Promise.all([
      db.countMemories(userId),
      summarizeAffinity(db, userId)
    ])

    const response: StatsResponse = {
      totals: {
        sessions: sessions.length,
        messages: messageCount,
        turns: metrics.length,
        toolCalls,
        inputTokens,
        outputTokens,
        totalTokens
      },
      series: [...series.values()],
      channels: [...channelMap.entries()]
        .map(([channel, count]) => ({ channel, count }))
        .sort((a, b) => b.count - a.count),
      models: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 6),
      providers: [...providerMap.values()]
        .sort((a, b) => b.tokens - a.tokens || b.turns - a.turns)
        .slice(0, 6),
      tools: [...toolMap.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      plugins: { total: plugins.length, enabled: plugins.filter((p) => p.enabled).length, byKind },
      memories: memoryCount,
      affinity: { score: affinity.score, stageKey: affinity.stageKey }
    }
    return c.json(response)
  })

  return app
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

function buildDayKeys(days: number): string[] {
  const today = startOfDay(Date.now())
  return Array.from({ length: days }, (_, index) => dayKey(today - (days - 1 - index) * 86_400_000))
}
