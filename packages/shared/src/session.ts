import type { Emotion } from './emotion.ts'
import type { ToolStatus } from './sse.ts'

/** 渠道：桌面客户端 / 飞书机器人，会话按渠道存同一数据库 */
export type Channel = 'desktop' | 'feishu'

export type Role = 'user' | 'assistant'

/**
 * 回合模式——**回合级属性，不是会话级**：
 * 语音与文本窗口共享同一个会话与消息序列，可随时切换继续；
 * 每个回合按发起时的模式决定输出格式（语音=双语言，文本=仅中文）。
 */
export type TurnMode = 'text' | 'voice'

export interface Message {
  id: string
  sessionId: string
  role: Role
  /** 中文，规范内容：UI 展示 + LLM 上下文只用它 */
  content: string
  /** 语音回合的日文（TTS 合成用）。隐藏字段：不展示、不进 LLM 上下文 */
  ttsText?: string | null
  /** 回合发起时的模式 */
  mode: TurnMode
  createdAt: number
}

export interface Session {
  id: string
  channel: Channel
  title: string
  createdAt: number
  updatedAt: number
  /** 服务端会话列表附带的消息数（历史页统计用；未加载消息时也可见） */
  messageCount?: number
}

/** 会话列表按天分组的组名（今天 / 昨天 / 本周 / 更早） */
export type DayGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier'

const DAY_MS = 86_400_000

export function dayGroupOf(ts: number, now: Date = new Date()): DayGroup {
  const date = new Date(ts)
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffDays = Math.round((todayStart.getTime() - dayStart.getTime()) / DAY_MS)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return 'thisWeek'
  return 'earlier'
}

export const DAY_GROUP_ORDER: readonly DayGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier']

/** 本回合单个工具的执行活动（不落库，仅流式期间展示） */
export interface ToolActivityItem {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: ToolStatus
  /** 部分输出 / 结果摘要（快照式，可空） */
  summary?: string
  details?: Record<string, unknown>
}

/** 待用户确认的 bash 命令（同时最多一个） */
export interface PendingToolConfirm {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  expiresAt: number
}

/** 助手消息的临时流式状态（不落库，仅内存/传输态） */
export interface StreamState {
  streaming: boolean
  /** 流式中的助手消息（含情绪，驱动 Live2D） */
  draft?: {
    messageId: string
    content: string
    emotion?: Emotion
  }
  /** 本回合 turnId（首个 tool 事件到来时设置） */
  turnId?: string
  /** 本回合工具活动列表（回合结束清空） */
  tools: ToolActivityItem[]
  /** 待确认的 bash 命令 */
  pendingConfirm?: PendingToolConfirm
}
