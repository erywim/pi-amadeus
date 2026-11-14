import type { Emotion } from './emotion.ts'

/** 主动问候设置：服务端空闲/时间窗/每日次数约束。 */
export interface ProactiveSettings {
  userId: string
  enabled: boolean
  minIdleMinutes: number
  activeStart: string
  activeEnd: string
  maxPerDay: number
  lastGreetedAt: number | null
}

/** 服务端持久化的传统空闲主动问候记录。 */
export interface ProactiveGreeting {
  id: string
  userId: string
  sessionId: string
  messageId: string
  content: string
  createdAt: number
}

/** 截图视觉主动问候的响应；它不会伪造空闲问候记录的持久化字段。 */
export interface ProactiveVisionGreeting {
  sessionId: string
  messageId: string
  text: string
  emotion: Emotion | null
  createdAt: number
}

export interface ProactiveResponse {
  settings: ProactiveSettings
  latest: ProactiveGreeting | null
  todayCount: number
}

export interface ProactiveInput {
  enabled?: boolean
  minIdleMinutes?: number
  activeStart?: string
  activeEnd?: string
  maxPerDay?: number
}

/** 主进程推送给渲染层的视觉问候事件。 */
export interface ProactiveMessageEvent extends ProactiveVisionGreeting {
  mode: 'window' | 'pet'
}
