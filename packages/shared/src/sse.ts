import type { Emotion } from './emotion.ts'

/**
 * SSE 事件词汇（沿用原版跨端契约）：delta / done / error。
 * `delta` 内容永远只有中文；语音模式另有 transcript / emotion 扩展事件；
 * 工具调用（文本/飞书回合）另有 tool_* 扩展事件。
 */
export type SseEventType =
  | 'delta'
  | 'done'
  | 'error'
  | 'transcript'
  | 'emotion'
  | 'audio'
  | 'tool_start'
  | 'tool_update'
  | 'tool_end'
  | 'tool_confirm'

/** 工具执行状态（渲染端展示用） */
export type ToolStatus = 'running' | 'success' | 'error' | 'denied' | 'timeout' | 'blocked'

export interface SseEventBase {
  type: SseEventType
}

/** 流式增量：永远只有中文（canonical 内容） */
export interface SseDeltaEvent extends SseEventBase {
  type: 'delta'
  delta: string
}

/** 单回合完成 */
export interface SseDoneEvent extends SseEventBase {
  type: 'done'
  sessionId: string
  messageId: string
  /** 会话自动标题（首轮后异步生成，可能后到） */
  title?: string
}

export interface SseErrorEvent extends SseEventBase {
  type: 'error'
  message: string
  code?: string
}

/** 语音模式：用户语音转写结果 */
export interface SseTranscriptEvent extends SseEventBase {
  type: 'transcript'
  text: string
}

/** 语音模式：LLM 流内联情绪（供 Live2D 表情驱动） */
export interface SseEmotionEvent extends SseEventBase {
  type: 'emotion'
  emotion: Emotion
}

/** 语音模式：TTS 音频块（base64，16bit 单声道 PCM，s16le） */
export interface SseAudioEvent extends SseEventBase {
  type: 'audio'
  data: string
  sampleRate: number
}

/** 工具开始执行（LLM 选中某工具后、execute 前） */
export interface SseToolStartEvent extends SseEventBase {
  type: 'tool_start'
  /** 回合唯一 ID（大脑随机生成；确认回执用它定位回合） */
  turnId: string
  toolCallId: string
  toolName: string
  /** 展示名兜底（渲染端优先用 i18n chat.toolName.<toolName>） */
  label: string
  args: Record<string, unknown>
}

/** 工具执行中的部分输出（快照式，整体替换而非追加） */
export interface SseToolUpdateEvent extends SseEventBase {
  type: 'tool_update'
  turnId: string
  toolCallId: string
  toolName: string
  partial: string
}

/** 工具执行结束 */
export interface SseToolEndEvent extends SseEventBase {
  type: 'tool_end'
  turnId: string
  toolCallId: string
  toolName: string
  isError: boolean
  /** 最终结果文本（服务端已截断 ~4KB，供 UI 摘要/折叠） */
  result: string
  /** 结构化详情（bash 的 deniedReason: 'blocked'|'user_denied'|'timeout'|'aborted' 等） */
  details?: Record<string, unknown>
}

/** bash 命令确认握手（仅 desktop 渠道、仅 bash 工具） */
export interface SseToolConfirmEvent extends SseEventBase {
  type: 'tool_confirm'
  turnId: string
  toolCallId: string
  toolName: string
  label: string
  args: Record<string, unknown>
  /** 确认截止时间（epoch ms），渲染端倒计时；到时服务端自动拒绝 */
  expiresAt: number
}

export type SseEvent =
  | SseDeltaEvent
  | SseDoneEvent
  | SseErrorEvent
  | SseTranscriptEvent
  | SseEmotionEvent
  | SseAudioEvent
  | SseToolStartEvent
  | SseToolUpdateEvent
  | SseToolEndEvent
  | SseToolConfirmEvent
