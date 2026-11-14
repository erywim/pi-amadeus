import type { ComputerRequest } from './computer.ts'
import type { Emotion } from './emotion.ts'
import type { ToolStatus } from './sse.ts'

/**
 * 渠道：桌面客户端 / 飞书 / 各通讯平台适配器，会话按渠道存同一数据库。
 * 平台渠道值就是 PlatformKind（telegram / onebot / webhook），看板按它分组。
 */
export type Channel =
  | 'desktop'
  | 'feishu'
  | 'telegram'
  | 'onebot'
  | 'webhook'
  | 'discord'
  | 'slack'
  | 'wechat'
  | 'qqbot'
  | 'automation'

export type Role = 'user' | 'assistant'

/**
 * 回合模式——**回合级属性，不是会话级**：
 * 语音与文本窗口共享同一个会话与消息序列，可随时切换继续；
 * 每个回合按发起时的模式决定输出格式（语音=双语言，文本=仅中文）。
 */
export type TurnMode = 'text' | 'voice'

/** 本回合工作区里状态发生变化的文件（真实 git 状态快照差集）。 */
export interface TurnChangedFile {
  path: string
  status: string
}

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
  /** 分支树父节点；根消息为 null */
  parentId?: string | null
  /** 同一父节点下的第几条 / 总数（分支切换器） */
  branchIndex?: number
  branchCount?: number
  /** 图片 / 语音 / 文件附件（文件本体在服务端数据目录） */
  attachments?: import('./attachment.ts').MessageAttachment[]
  /** 本回合工作区改动（仅桌面端真实 git 快照有差异时才有） */
  changedFiles?: TurnChangedFile[]
  /** 模型真实返回的思考过程 */
  thinking?: string
  createdAt: number
}

export interface Session {
  id: string
  channel: Channel
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  archived?: boolean
  /** 服务端会话列表附带的消息数（历史页统计用；未加载消息时也可见） */
  messageCount?: number
}

export interface SessionUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  model: string
}

export interface MessageSearchHit {
  sessionId: string
  sessionTitle: string
  channel: Channel
  messageId: string
  role: Role
  snippet: string
  createdAt: number
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

/** 待用户确认的本机工具调用（同时最多一个）。 */
export type ToolConfirmKind = 'bash' | 'computer'

export interface PendingToolConfirm {
  toolCallId: string
  toolName: string
  /** 面向用户的服务/动作标签；旧 bash 确认没有该字段时用 toolName 兜底。 */
  label?: string
  kind: ToolConfirmKind
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
    thinking?: string
  }
  /** 本回合 turnId（首个 tool 事件到来时设置） */
  turnId?: string
  /** 本回合工具活动列表（回合结束清空） */
  tools: ToolActivityItem[]
  /** 待确认的 bash 命令 */
  pendingConfirm?: PendingToolConfirm
  /** 待执行的 computer 请求；截图/输入结果不落库 */
  pendingComputer?: ComputerRequest
}
