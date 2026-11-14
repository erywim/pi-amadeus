import type { MessageAttachment } from './attachment.ts'
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

/** 本回合期间工作区里状态发生变化的文件（真实 git status 快照差集） */
export interface TurnChangedFile {
  /** 相对工作区根目录的 POSIX 路径 */
  path: string
  /** 回合结束时的 porcelain 状态码（M / A / D / R / ?? …） */
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
  /** 同一父节点下的第几条 / 总数（分支切换器） */
  branchIndex?: number
  branchCount?: number
  /** 图片 / 语音 / 文件附件（文件本体在服务端数据目录） */
  attachments?: MessageAttachment[]
  /** 本回合工作区改动（仅桌面端真实 git 快照有差异时才有） */
  changedFiles?: TurnChangedFile[]
  /**
   * 思考过程（模型真实返回的 reasoning 内容；未开启思考或供应商不返回时为空）。
   * 只展示，不回灌 LLM 上下文——重放思考块会显著增加成本且易被供应商拒收。
   */
  thinking?: string
  createdAt: number
  /** 父消息 id（会话是一棵树；根消息为 null） */
  parentId?: string | null
  /**
   * 同一父节点下的兄弟（按创建时间排序，含自己）。只有"活动世界线"上的
   * 消息会带；siblingCount > 1 表示这里发生过世界线分叉。
   */
  siblingIds?: string[]
}

/**
 * 世界线：会话树里从根到某个叶子的一条路径。
 * 同一会话的所有世界线共享前缀，分叉点是某条消息有了第二个子节点。
 */
export interface WorldlineInfo {
  /** 当前活动末端（叶子，或回退到中途的节点）；空会话为 null */
  headId: string | null
  /** 当前世界线序号（1-based，按叶子最早创建时间排序） */
  index: number
  /** 本会话的世界线总数（叶子数） */
  total: number
  /** 世界线变动率：由当前末端 id 稳定推导，1.000000 ~ 1.999999（主题展示值） */
  divergence: number
  /** 是否停在世界线中途（回退状态）：从这里继续会分叉出一条新世界线 */
  rewound: boolean
}

/** 会话消息页：活动世界线的完整路径 + 世界线元信息 */
export interface SessionMessages {
  messages: Message[]
  worldline: WorldlineInfo
}

/** 世界线跳转结果（服务端返回跳转后的消息页，省一次往返） */
export type JumpResult = SessionMessages

/** 世界线列表项（跳转面板用） */
export interface WorldlineSummary {
  leafId: string
  index: number
  divergence: number
  /** 这条世界线最后一句话的摘要（用户消息优先） */
  preview: string
  /** 世界线末端时间 */
  updatedAt: number
  /** 是否当前活动世界线 */
  active: boolean
}

export interface Session {
  id: string
  channel: Channel
  title: string
  createdAt: number
  updatedAt: number
  /** 置顶会话排在列表最前（置顶不改变 updated_at） */
  pinned?: boolean
  /** 已归档：默认列表隐藏，可在侧栏「已归档」里恢复 */
  archived?: boolean
  /** 服务端会话列表附带的消息数（历史页统计用；未加载消息时也可见） */
  messageCount?: number
}

/** 跨会话消息搜索命中（侧栏全文搜索） */
export interface MessageSearchHit {
  sessionId: string
  sessionTitle: string
  channel: Channel
  messageId: string
  role: Role
  /** 命中位置前后各 40 字的原文片段 */
  snippet: string
  createdAt: number
}

/** 会话级 token 用量（来自 turn_metrics 的真实累计） */
export interface SessionUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 最近一次回合使用的模型 */
  model: string
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
    /** 流式中的思考内容（供应商真实返回的 reasoning 增量） */
    thinking?: string
  }
  /** 本回合 turnId（首个 tool 事件到来时设置） */
  turnId?: string
  /** 本回合工具活动列表（回合结束清空） */
  tools: ToolActivityItem[]
  /** 待确认的 bash 命令 */
  pendingConfirm?: PendingToolConfirm
}
