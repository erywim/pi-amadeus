/**
 * 语音回合双语言契约。
 *
 * 语音回合中 LLM 同时产出中文与日文（语义一致，日文先于中文流式返回）：
 * - 中文（displayText）是规范内容：SSE `delta`、UI 展示、LLM 上下文只用它
 * - 日文（ttsText）随消息以隐藏字段持久化，不进 LLM 上下文；
 *   历史语音回放时用存储的 ttsText 重新合成（Audio Fish 音色固定，结果一致）
 *
 * 双语言标记格式是大脑 ↔ LLM 的内部契约，此类型只描述解析后的结果，
 * 前端展示层与存储层无感知。
 */
export interface BilingualText {
  /** 中文，规范内容 */
  displayText: string
  /** 日文，TTS 合成用 */
  ttsText: string
}
