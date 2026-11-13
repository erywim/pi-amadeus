/**
 * 多模型服务（参考 magpie 的 Providers 思路）：
 * 一份服务 = 一个 OpenAI 兼容端点 + 密钥 + 默认模型。
 * 当前激活的服务优先于设置页里的单条内置配置；没有服务时回落到内置配置。
 * 密钥只存在于服务端，列表接口只回传「是否已配置」。
 */

export interface ProviderItem {
  id: string
  name: string
  baseUrl: string
  model: string
  proxy: string
  enabled: boolean
  /** 同一时间只有一个激活服务 */
  active: boolean
  priority: number
  /** 是否已配置密钥（不返回密钥本身） */
  apiKeySet: boolean
  /**
   * 最近一次真实回合/测试失败后进入的临时冷却（10 分钟）。
   * 冷却期间回合会按优先级自动改用下一个健康服务；成功后立即解除。
   */
  coolingDown?: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderInput {
  name: string
  baseUrl: string
  model: string
  /** 留空 = 保持已保存的密钥不变（编辑时） */
  apiKey?: string
  proxy?: string
  enabled?: boolean
  priority?: number
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs?: number
  /** 模型返回的一小段文本，用于确认链路真的通了 */
  reply?: string
  error?: string
}
