/**
 * 多模型服务（多模型服务）：
 * 一份服务 = 一个 OpenAI 兼容端点 + 密钥 + 默认模型。
 * 当前激活的服务优先于设置页里的单条内置配置；没有服务时回落到内置配置。
 * 密钥只存在于服务端，列表接口只回传「是否已配置」。
 */

import type { ThinkingLevel } from './config.ts'

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
  /** 路由标签：chat / vision / summary / memory */
  tags: string[]
  /** 每日 token 配额（0 = 不限） */
  dailyTokenQuota: number
  /** 思考级别（缺省 off） */
  thinkingLevel: ThinkingLevel
  /** 上下文窗口（token）；0 = 用默认 128k */
  contextWindow: number
  /** 单次回复输出上限（token）；0 = 用默认 8192 */
  maxTokens: number
  /** 今天已使用的 token（来自真实回合指标） */
  todayTokens: number
  /** 今天是否已超过配额 */
  quotaExceeded: boolean
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
  /** 路由标签；缺省 chat */
  tags?: string[]
  /** 每日 token 配额；0 = 不限 */
  dailyTokenQuota?: number
  enabled?: boolean
  priority?: number
  /** 思考级别；缺省 off（不请求思考） */
  thinkingLevel?: ThinkingLevel
  /** 上下文窗口；0/缺省 = 128k */
  contextWindow?: number
  /** 输出上限；0/缺省 = 8192 */
  maxTokens?: number
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs?: number
  /** 模型返回的一小段文本，用于确认链路真的通了 */
  reply?: string
  error?: string
}
