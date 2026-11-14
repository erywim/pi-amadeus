/**
 * 主动问候：用户长时间没说话时，角色基于真实记忆/好感度主动发一条消息。
 * 只由真实空闲时间与真实模型触发，不发固定模板、不伪造互动。
 */

export interface ProactiveSettings {
  userId: string
  enabled: boolean
  /** 至少空闲多少分钟才考虑问候 */
  minIdleMinutes: number
  /** 允许问候的时间窗（本地时间 HH:MM，支持跨午夜） */
  activeStart: string
  activeEnd: string
  /** 每天最多问候次数 */
  maxPerDay: number
  lastGreetedAt: number | null
}

export interface ProactiveGreeting {
  id: string
  userId: string
  sessionId: string
  messageId: string
  content: string
  createdAt: number
}

export interface ProactiveResponse {
  settings: ProactiveSettings
  /** 最近一条主动问候（没有则为 null） */
  latest: ProactiveGreeting | null
  /** 今天已经问候的次数 */
  todayCount: number
}

export interface ProactiveInput {
  enabled?: boolean
  minIdleMinutes?: number
  activeStart?: string
  activeEnd?: string
  maxPerDay?: number
}
