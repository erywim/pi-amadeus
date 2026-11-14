import type { CompactionLevel } from '@pi-amadeus/shared'
import type { CompactionRow, Db, MessageRow } from '../db.ts'
import { completeText, type LlmTarget } from '../llm.ts'
import {
  HISTORY_FALLBACK_LIMIT,
  HISTORY_LOAD_LIMIT,
  INPUT_BUDGET_TOKENS,
  PROMPT_OVERHEAD_TOKENS,
  type CompactionPolicy,
  policyOf
} from './limits.ts'
import {
  extractSummary,
  mergeSummaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
  summaryPrompt
} from './prompt.ts'
import { estimateMessagesTokens, estimateTextTokens } from './tokens.ts'

/**
 * 会话级上下文压缩（对应 Claude Code 的 autoCompact）：
 *
 *   历史消息 ──超过阈值──► [旧消息摘要] + [最近 N 条原文]
 *
 * 摘要持久化在 session_compactions 表：边界之前的消息不再进上下文，
 * 下次回合只带"摘要 + 边界之后的消息"，不必每回合重复摘要。
 *
 * 安全约束（宁可不压缩，也不丢用户数据）：
 * - 摘要调用失败 / 返回空 → 保留完整历史继续本回合，不写边界
 * - 边界消息找不到 → 用 createdAt 兜底；仍然定位不到就当作没有压缩过
 * - 只折叠"最近 N 条之前"的消息，尾部（含重新生成依赖的最后一条用户消息）永不动
 */

/** 一次压缩的统计（供 SSE 事件与看板展示） */
export interface CompactionReport {
  /** 本次是否新做了摘要（false = 沿用上次边界） */
  newlyCompacted: boolean
  /** 本次被折叠进摘要的消息条数 */
  summarizedMessages: number
  /** 压缩前历史估算 token */
  tokensBefore: number
  /** 压缩后上下文估算 token（摘要 + 保留原文） */
  tokensAfter: number
}

export interface PreparedHistory {
  /** 要放进 LLM 上下文的消息（时间正序；不含本次用户消息） */
  rows: MessageRow[]
  /** 上次/本次压缩得到的摘要（null = 没有压缩过） */
  summary: string | null
  report?: CompactionReport
}

export interface BuildHistoryInput {
  db: Db
  target: LlmTarget
  sessionId: string
  level: CompactionLevel
  /** 用户中断 / 回合取消：中断摘要请求，不写边界 */
  signal?: AbortSignal
}

/** 摘要请求的超时上限：压缩不该把一个回合拖到无限久 */
const SUMMARY_TIMEOUT_MS = 120_000

/**
 * 连续失败熔断（参考实现的 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3）：
 * 摘要服务持续失败时，不要每个回合都再试一次、把每回合都拖慢几十秒。
 * 成功一次即清零；只是进程内状态，重启后重新开始。
 */
const MAX_CONSECUTIVE_FAILURES = 3
const failureCounts = new Map<string, number>()

/**
 * 读取会话历史并按档位决定是否压缩。任何压缩失败都退回"完整历史"，
 * 调用方拿到的 rows 永远是可直接使用的上下文。
 */
export async function buildHistory(input: BuildHistoryInput): Promise<PreparedHistory> {
  const policy = policyOf(input.level)
  const limit = policy ? HISTORY_LOAD_LIMIT : HISTORY_FALLBACK_LIMIT
  // listMessages 只返回"活动世界线"这条路径：压缩永远作用于当前世界线
  const rows = await input.db.listMessages(input.sessionId, limit)

  // 关闭压缩：保持旧行为（最近 40 条），不读摘要、不调 LLM
  if (!policy) return { rows, summary: null }

  const boundary = await input.db.getCompaction(input.sessionId)
  const fresh = sliceAfterBoundary(rows, boundary)
  const previousSummary = boundary?.summary ?? null
  const tokensBefore = estimateMessagesTokens(fresh) + estimateTextTokens(previousSummary ?? '')

  // 未超阈值：沿用已有摘要 + 边界之后的全部消息
  if (tokensBefore <= availableBudget() * policy.triggerRatio) {
    return { rows: fresh, summary: previousSummary }
  }
  // 可折叠的消息不够（都在保留窗口里）：压缩没有意义，原样返回
  if (fresh.length <= policy.keepRecentMessages) {
    return { rows: fresh, summary: previousSummary }
  }

  const splitIndex = fresh.length - policy.keepRecentMessages
  const toSummarize = fresh.slice(0, splitIndex)
  const kept = fresh.slice(splitIndex)
  const lastSummarized = toSummarize[toSummarize.length - 1]!

  // 熔断：连续失败到上限后，本会话不再尝试摘要（仍按完整历史继续对话）
  if ((failureCounts.get(input.sessionId) ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    return { rows: fresh, summary: previousSummary }
  }

  let summary: string
  try {
    summary = await summarizeMessages(input.target, toSummarize, previousSummary, policy, input.signal)
  } catch (error) {
    failureCounts.set(input.sessionId, (failureCounts.get(input.sessionId) ?? 0) + 1)
    console.warn(
      '[compact] 摘要生成失败，本回合保留完整历史：',
      error instanceof Error ? error.message : error
    )
    return { rows: fresh, summary: previousSummary }
  }
  if (!summary.trim()) {
    failureCounts.set(input.sessionId, (failureCounts.get(input.sessionId) ?? 0) + 1)
    console.warn('[compact] 摘要为空，本回合保留完整历史')
    return { rows: fresh, summary: previousSummary }
  }
  failureCounts.delete(input.sessionId)

  // 先落库再返回：这一步失败也不影响本回合（上下文已经拿到摘要），
  // 只是下一回合会重新摘要一次
  const row: CompactionRow = {
    sessionId: input.sessionId,
    summary,
    throughMessageId: lastSummarized.id,
    throughCreatedAt: lastSummarized.createdAt,
    messagesSummarized: toSummarize.length,
    tokensBefore,
    tokensAfter: estimateMessagesTokens(kept) + estimateTextTokens(summary),
    updatedAt: Date.now()
  }
  try {
    await input.db.setCompaction(row)
  } catch (error) {
    console.warn('[compact] 压缩边界写入失败：', error instanceof Error ? error.message : error)
  }

  return {
    rows: kept,
    summary,
    report: {
      newlyCompacted: true,
      summarizedMessages: toSummarize.length,
      tokensBefore,
      tokensAfter: row.tokensAfter
    }
  }
}

/** 可用输入预算（扣除系统提示词与记忆等固定开销） */
function availableBudget(): number {
  return INPUT_BUDGET_TOKENS - PROMPT_OVERHEAD_TOKENS
}

/**
 * 取边界之后的消息。优先按消息 id 精确定位；id 已被删（重新生成替换旧回复）
 * 时退回时间边界；两条路都找不到就返回全部——未知不等于"全部已摘要"。
 */
function sliceAfterBoundary(rows: MessageRow[], boundary: CompactionRow | null): MessageRow[] {
  if (!boundary) return rows
  const byId = rows.findIndex((row) => row.id === boundary.throughMessageId)
  if (byId >= 0) return rows.slice(byId + 1)
  let byTime = -1
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.createdAt <= boundary.throughCreatedAt) byTime = i
  }
  return byTime >= 0 ? rows.slice(byTime + 1) : rows
}

/** 单条历史消息的摘要输入行 */
function messageLine(row: MessageRow): string {
  return `【${row.role === 'user' ? '用户' : '助手'}】${row.content}`
}

/** 按 token 预算分块（单条超预算的消息独占一块） */
function chunkMessages(messages: MessageRow[], chunkTokens: number): MessageRow[][] {
  const chunks: MessageRow[][] = []
  let current: MessageRow[] = []
  let tokens = 0
  for (const message of messages) {
    const size = estimateTextTokens(message.content) + 8
    if (current.length > 0 && tokens + size > chunkTokens) {
      chunks.push(current)
      current = []
      tokens = 0
    }
    current.push(message)
    tokens += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 迭代摘要：旧摘要 + 新消息逐块合并成一份新摘要。
 * 分块是为了让"要压缩的历史"本身不超过模型窗口（超长会话也不会一次爆掉）。
 */
async function summarizeMessages(
  target: LlmTarget,
  messages: MessageRow[],
  previousSummary: string | null,
  policy: CompactionPolicy,
  signal?: AbortSignal
): Promise<string> {
  const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

  let summary = previousSummary?.trim() ?? ''
  for (const chunk of chunkMessages(messages, policy.chunkTokens)) {
    const text = chunk.map(messageLine).join('\n\n')
    const prompt = summary ? mergeSummaryPrompt(summary, text) : summaryPrompt(text)
    const raw = await completeText(
      target,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }]
      },
      { signal: combinedSignal }
    )
    const next = extractSummary(raw)
    // 空输出：保留上一版摘要，继续下一块（不把空摘要写进边界）
    if (next) summary = next
  }
  return summary
}
