import type { CompactionLevel } from '@pi-amadeus/shared'

/**
 * 上下文预算与压缩策略参数。阈值口径统一为"估算输入 token 占输入预算的比例"，
 * 输入预算 = 上下文窗口 - 输出预留 - 安全余量（估算本身有误差，留余量兜底）。
 */

/** 模型上下文窗口（与 llm.ts 的 Model 描述保持一致） */
export const CONTEXT_WINDOW_TOKENS = 128_000
/** 单次回复的最大输出 token（与 llm.ts 的 Model.maxTokens 保持一致） */
export const MAX_OUTPUT_TOKENS = 8_192
/** 估算误差 + 供应商模板开销的安全余量 */
const SAFETY_MARGIN_TOKENS = 4_000

/** 可用的输入 token 预算 */
export const INPUT_BUDGET_TOKENS = CONTEXT_WINDOW_TOKENS - MAX_OUTPUT_TOKENS - SAFETY_MARGIN_TOKENS

/** 系统提示词 / 记忆召回等非历史内容的粗略开销（从预算里先扣掉） */
export const PROMPT_OVERHEAD_TOKENS = 2_000

/** 关闭压缩时仍然保留的历史条数（旧行为，防止单次请求无限增长） */
export const HISTORY_FALLBACK_LIMIT = 40

/** 开启压缩后一次最多读取的历史条数（够摘要出边界，也不会把整库读进内存） */
export const HISTORY_LOAD_LIMIT = 200

export interface CompactionPolicy {
  /** 历史估算 token 超过输入预算的这个比例 → 触发摘要压缩 */
  triggerRatio: number
  /** 压缩时保留最近多少条消息不进摘要（逐字保留） */
  keepRecentMessages: number
  /** 一次摘要请求的输入上限（超过则分块迭代摘要） */
  chunkTokens: number
  /** 回合内工具结果微压缩的触发比例 */
  microTriggerRatio: number
  /** 微压缩保留最近多少条工具结果原文 */
  keepRecentToolResults: number
}

/** 两档策略：balanced 是缺省，aggressive 更早压缩、保留更少原文 */
export const COMPACTION_POLICIES: Record<Exclude<CompactionLevel, 'off'>, CompactionPolicy> = {
  balanced: {
    triggerRatio: 0.72,
    keepRecentMessages: 8,
    chunkTokens: 36_000,
    microTriggerRatio: 0.6,
    keepRecentToolResults: 3
  },
  aggressive: {
    triggerRatio: 0.55,
    keepRecentMessages: 4,
    chunkTokens: 28_000,
    microTriggerRatio: 0.45,
    keepRecentToolResults: 2
  }
}

export function policyOf(level: CompactionLevel): CompactionPolicy | null {
  return level === 'off' ? null : COMPACTION_POLICIES[level]
}
