/**
 * 用户级 AI 配置（沿用原版 InputData 配置模型的字段语义，
 * 修正其 localStorage / 数据库 / 进程内 dict 三处重复存储的缺陷——
 * v1 以服务端 SQLite `user_configs` 表为单一来源）。
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

/** 工具调用配置（v1：仅一个总开关，缺省视为开启） */
export interface ToolConfig {
  /** 文本/飞书回合是否启用工具调用（关闭后 LLM 收不到任何工具定义，纯文本对话） */
  enabled: boolean
}

/**
 * 上下文压缩档位（参考 Claude Code 的分层压缩策略，见 docs/context-compaction.md）：
 * - off：只按消息条数截断（旧行为，不额外调用 LLM）
 * - balanced：接近上下文窗口上限时把旧历史摘要成一段结构化摘要（缺省）
 * - aggressive：更早触发摘要、保留更少的原文消息
 */
export type CompactionLevel = 'off' | 'balanced' | 'aggressive'

/** 动态工作流档位（参考 Claude Code 的 Workflow 工具，见 docs/dynamic-workflow.md） */
export type WorkflowLevel = 'off' | 'standard' | 'max'

export interface CompactionConfig {
  level: CompactionLevel
}

export interface WorkflowConfig {
  level: WorkflowLevel
}

export interface UserConfig {
  provider: LlmProviderConfig
  /** 输出语言（v1 中文为标准内容，此字段保留跨端契约并影响 UI 语言默认值） */
  outputLanguage: OutputLanguage
  /** Kurisu 傲娇人格系统提示词，支持用户自定义覆盖 */
  systemPrompt: string
  temperature?: number
  /** 工具调用开关（缺省视为 enabled=true，兼容存量配置） */
  tools?: ToolConfig
  /** 上下文压缩配置（缺省按 balanced 处理） */
  compaction?: CompactionConfig
  /** 动态工作流配置（缺省按 off 处理：不注册 workflow 工具） */
  workflow?: WorkflowConfig
}

export const DEFAULT_SYSTEM_PROMPT = `你是"牧濑红莉栖"（Kurisu Makise），天才少女科学家。`
