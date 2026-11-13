/**
 * 自动化任务（参考常见的定时任务设计）：
 * 到点后用一个真实 agent 回合执行用户写好的指令，结果落进独立会话。
 * 调度器只按数据库里的 next_run_at 触发；没有到期任务就不做任何事。
 */

export type AutomationSchedule = 'interval' | 'daily' | 'once'

/** 空字符串表示还没跑过；running 是进行中（防止同一任务重入） */
export type AutomationRunStatus = '' | 'running' | 'success' | 'error'

export interface AutomationItem {
  id: string
  name: string
  prompt: string
  schedule: AutomationSchedule
  /** interval：间隔分钟数（>= 5） */
  intervalMinutes: number
  /** daily：本地时间 HH:MM */
  timeOfDay: string
  /** once：绝对时间戳（毫秒） */
  runAt: number | null
  enabled: boolean
  /** 下次触发时间；关闭或一次性任务跑完后为 null */
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: AutomationRunStatus
  lastError: string
  /** 最近一次成功回合的完整回复（用于列表里展开查看） */
  lastResult: string
  /** 该自动化任务的会话 id（automation-<id>），可在桌面端打开继续 */
  sessionId: string
  createdAt: number
  updatedAt: number
}

export interface AutomationInput {
  name: string
  prompt: string
  schedule: AutomationSchedule
  intervalMinutes?: number
  timeOfDay?: string
  runAt?: number | null
  enabled?: boolean
}
