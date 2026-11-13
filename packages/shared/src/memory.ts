/**
 * 长期记忆与好感度（参考 Shiori-Agent 的角色中心设计）：
 * 记忆是从真实对话里提取的长期事实，好感度是真实互动事件的累计值。
 * 两者都不接受手工伪造：没有发生过的互动就不会有记录。
 */

export type MemoryKind = 'fact' | 'preference' | 'event' | 'relationship'

export interface MemoryItem {
  id: string
  content: string
  kind: MemoryKind
  /** 置顶记忆每回合都会进入上下文，不参与相关度筛选 */
  pinned: boolean
  createdAt: number
  lastUsedAt: number | null
  sourceSessionId: string | null
}

export interface MemoryListResponse {
  memories: MemoryItem[]
  /** 该用户的记忆总数（不受搜索过滤影响） */
  total: number
}

export interface AffinityEvent {
  delta: number
  /** 事件原因（回合互动 / 深入交流 / 一起完成任务 / 记住了一件事…） */
  reason: string
  createdAt: number
}

export interface AffinityDailyPoint {
  /** YYYY-MM-DD */
  day: string
  /** 当天结束时的累计值 */
  score: number
  /** 当天增量 */
  delta: number
}

/** 关系阶段：索引即阶段等级，0 最低 */
export const AFFINITY_STAGES = [
  { key: 'stranger', min: 0 },
  { key: 'acquaintance', min: 10 },
  { key: 'familiar', min: 30 },
  { key: 'close', min: 60 },
  { key: 'fond', min: 100 },
  { key: 'beloved', min: 180 }
] as const

export type AffinityStageKey = (typeof AFFINITY_STAGES)[number]['key']

export interface AffinitySummary {
  score: number
  stage: number
  stageKey: AffinityStageKey
  /** 进入下一阶段所需分数；已是最高阶段为 null */
  nextAt: number | null
  events: AffinityEvent[]
  /** 最近 14 天，按天升序 */
  daily: AffinityDailyPoint[]
  /** 第一次互动时间（没有互动为 null） */
  since: number | null
}

export function affinityStageOf(score: number): { stage: number; key: AffinityStageKey; nextAt: number | null } {
  let stage = 0
  for (let index = 0; index < AFFINITY_STAGES.length; index += 1) {
    if (score >= AFFINITY_STAGES[index]!.min) stage = index
  }
  const next = AFFINITY_STAGES[stage + 1]
  return {
    stage,
    key: AFFINITY_STAGES[stage]!.key,
    nextAt: next ? next.min : null
  }
}
