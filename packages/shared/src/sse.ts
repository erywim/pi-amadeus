import type { Emotion } from './emotion.ts'

/**
 * SSE 事件词汇（沿用原版跨端契约）：delta / done / error。
 * `delta` 内容永远只有中文；语音模式另有 transcript / emotion 扩展事件。
 */
export type SseEventType = 'delta' | 'done' | 'error' | 'transcript' | 'emotion' | 'audio'

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

export type SseEvent = SseDeltaEvent | SseDoneEvent | SseErrorEvent | SseTranscriptEvent | SseEmotionEvent | SseAudioEvent
