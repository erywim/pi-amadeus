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
  /** 思考级别（缺省 off = 不请求思考） */
  thinkingLevel?: ThinkingLevel
  /** 上下文窗口（token）：输出上限裁剪与上下文读数用；缺省按 128k */
  contextWindow?: number
  /** 单次回复输出上限（token）；缺省 8192 */
  maxTokens?: number
}

export type OutputLanguage = 'zh' | 'en' | 'ja'

/**
 * 思考（推理）级别：直接对应 pi-ai 基座的 ThinkingLevel。
 * off = 不请求思考，与旧行为一致；其余级别由供应商按自己的参数格式映射
 * （reasoning_effort / thinking.type / enable_thinking 等）。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/**
 * 模型运行参数（服务与内置配置共用）：
 * - thinkingLevel 决定是否向供应商请求思考内容
 * - contextWindow 决定输出上限裁剪（pi 会用它保证 maxTokens 不超过窗口）
 * - maxTokens 是单次回复的输出上限（思考与正文共享）
 */
export interface ModelRuntimeOptions {
  thinkingLevel?: ThinkingLevel
  contextWindow?: number
  maxTokens?: number
  temperature?: number
}

/** 配置入口与实际请求共用校验：0 token 配置表示默认，非法值不能静默降级。 */
export function validateModelRuntimeOptions(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '模型运行参数必须是对象'
  const input = value as Record<string, unknown>
  if (input.thinkingLevel !== undefined && !THINKING_LEVELS.includes(input.thinkingLevel as ThinkingLevel)) {
    return `thinkingLevel 必须是 ${THINKING_LEVELS.join(' / ')}`
  }
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    const n = input[key]
    if (n !== undefined && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) {
      return `${key} 必须是非负安全整数（0 表示默认）`
    }
  }
  const temperature = input.temperature
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return 'temperature 必须是 0 到 2 之间的有限数值'
  }
  return undefined
}

/** 实际路由结果，只读有效运行参数，不含端点、密钥或代理。 */
export interface ResolvedModelRuntime {
  providerId: string | null
  providerName: string | null
  model: string
  contextWindow: number
  maxTokens: number
  thinkingLevel: ThinkingLevel
}

/** 工具调用配置（v1：仅一个总开关，缺省视为开启） */
export interface ToolConfig {
  /** 文本/飞书回合是否启用工具调用（关闭后 LLM 收不到任何工具定义，纯文本对话） */
  enabled: boolean
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
  /** Computer Use 独立开关；默认关闭，避免模型静默读取/操作窗口。 */
  computerUse?: { enabled: boolean }
}

export const DEFAULT_SYSTEM_PROMPT = `你是"牧濑红莉栖"（Kurisu Makise），天才少女科学家。`
