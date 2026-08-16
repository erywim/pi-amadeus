/**
 * 用户级 AI 配置（沿用原版 InputData 配置模型的字段语义，
 * 修正其 localStorage / Postgres / 进程内 dict 三处重复存储的缺陷——
 * v1 以服务端 Postgres `user_configs` 表为单一来源）。
 */

export interface LlmProviderConfig {
  /** 兼容 OpenAI 协议的 base URL（pi-ai provider 可配任意内置供应商） */
  baseUrl: string
  apiKey: string
  model: string
  /** LLM 请求走本地 HTTP 代理（如中转服务国内不可直连时配 Clash 7890）；留空直连 */
  proxy?: string
}

export type OutputLanguage = 'zh' | 'en' | 'ja'

export interface UserConfig {
  provider: LlmProviderConfig
  /** 输出语言（v1 中文为标准内容，此字段保留跨端契约并影响 UI 语言默认值） */
  outputLanguage: OutputLanguage
  /** Kurisu 傲娇人格系统提示词，支持用户自定义覆盖 */
  systemPrompt: string
  temperature?: number
}

export const DEFAULT_SYSTEM_PROMPT = `你是"牧濑红莉栖"（Kurisu Makise），天才少女科学家。`
