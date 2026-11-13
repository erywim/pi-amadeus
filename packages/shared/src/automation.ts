/**
 * 自动化任务（参考常见的定时任务设计）：
 * 到点后用一个真实 agent 回合执行用户写好的指令，结果落进独立会话。
 * 调度器只按数据库里的 next_run_at 触发；没有到期任务就不做任何事。
 */

export type AutomationSchedule = 'interval' | 'daily' | 'once'

/** 触发方式：定时 / 文件变化 / Webhook */
export type AutomationTrigger = 'schedule' | 'file' | 'webhook'

/** 空字符串表示还没跑过；running 是进行中（防止同一任务重入） */
export type AutomationRunStatus = '' | 'running' | 'success' | 'error'

export interface AutomationItem {
  id: string
  name: string
  prompt: string
  trigger: AutomationTrigger
  /** file：监听的文件或目录（绝对路径） */
  watchPath: string
  /** file：变更防抖秒数 */
  debounceSeconds: number
  /** webhook：调用方需要携带的密钥（空表示不校验） */
  webhookSecret: string
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
  /** 最近一次触发来源（手动 / 定时 / 文件路径 / Webhook） */
  lastTrigger: string
  /** 该自动化任务的会话 id（automation-<id>），可在桌面端打开继续 */
  sessionId: string
  createdAt: number
  updatedAt: number
}

export interface AutomationInput {
  name: string
  prompt: string
  trigger?: AutomationTrigger
  watchPath?: string
  debounceSeconds?: number
  webhookSecret?: string
  schedule?: AutomationSchedule
  intervalMinutes?: number
  timeOfDay?: string
  runAt?: number | null
  enabled?: boolean
}
