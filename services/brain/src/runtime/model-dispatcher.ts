import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { isProviderCoolingDown } from '../providers/failover.ts'
import type { LlmTarget, ModelDispatcher, RoutePurpose } from './contracts.ts'
import { supportsVision } from './model-capabilities.ts'

/**
 * 模型调度器：一次决定「本回合用哪个模型」，调用方拿到结果后全程复用。
 *
 * 规则（与旧 resolveTarget 一致，逐条保持不变）：
 * 1. 有激活且已配置密钥的模型服务时，先看它是否健康且匹配路由组；
 * 2. 不匹配则按 priority 顺序换下一个标签匹配、未冷却、未超每日配额的服务；
 * 3. 全部不可用（冷却/超配额/标签不符）时回落设置页内置配置，再回落 .env 默认。
 *
 * 依赖边界：这里只依赖 Db 与冷却状态，不导入 llm.ts / conversation.ts / tools——
 * 「选谁」和「怎么发请求」分开，避免一个回合里模型被重复选择。
 */

function startOfToday(): number {
  const date = new Date()
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 路由组：标签匹配 + 未冷却 + 未超每日配额 */
async function providerEligible(
  db: Db,
  provider: { id: string; tags: string; model: string; dailyTokenQuota: number },
  purpose: RoutePurpose
): Promise<boolean> {
  const tags = provider.tags.split(',').map((tag) => tag.trim())
  const tagMatch =
    tags.includes(purpose) ||
    (purpose === 'vision' && tags.includes('chat') && supportsVision(provider.model))
  if (!tagMatch) return false
  if (provider.dailyTokenQuota > 0) {
    const used = await db.providerUsageToday(provider.id, startOfToday())
    if (used >= provider.dailyTokenQuota) return false
  }
  return true
}

function targetOfProvider(provider: {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  proxy: string
  thinkingLevel?: string
  contextWindow?: number
  maxTokens?: number
}): LlmTarget {
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    vision: supportsVision(provider.model),
    proxy: provider.proxy,
    providerId: provider.id,
    providerName: provider.name,
    ...(provider.thinkingLevel && provider.thinkingLevel !== 'off'
      ? { thinkingLevel: provider.thinkingLevel as LlmTarget['thinkingLevel'] }
      : {}),
    ...(provider.contextWindow && provider.contextWindow > 0
      ? { contextWindow: provider.contextWindow }
      : {}),
    ...(provider.maxTokens && provider.maxTokens > 0 ? { maxTokens: provider.maxTokens } : {})
  }
}

/**
 * 本回合的模型覆盖：只改本次 target 的模型与视觉能力，不落库、不改用户配置。
 * 覆盖成视觉模型后 vision 必须重算，否则执行层会按旧能力丢掉图片块（或反之）。
 */
function withModelOverride(target: LlmTarget, model: string | undefined): LlmTarget {
  const next = model?.trim()
  if (!next || next === target.model) return target
  return { ...target, model: next, vision: supportsVision(next) }
}

export const resolveTarget: ModelDispatcher = async (
  cfg: BrainConfig,
  db: Db,
  userId: string,
  purpose: RoutePurpose = 'chat',
  options
) => {
  const providers = await db.listProviders()
  const active = providers.find((provider) => provider.active && provider.enabled)
  if (active && active.apiKey.trim()) {
    // 激活服务健康且符合路由组 → 用它；冷却/超配额/tag 不匹配 → 按 priority 换下一个
    if (!isProviderCoolingDown(active.id) && (await providerEligible(db, active, purpose))) {
      return withModelOverride(targetOfProvider(active), options?.model)
    }
    for (const provider of providers) {
      if (
        provider.id === active.id ||
        !provider.enabled ||
        !provider.apiKey.trim() ||
        isProviderCoolingDown(provider.id)
      ) {
        continue
      }
      if (await providerEligible(db, provider, purpose)) {
        return withModelOverride(targetOfProvider(provider), options?.model)
      }
    }
    // 所有服务都不可用（冷却/超配额）：回到内置配置，避免继续超额消耗
    console.warn(`[provider] 路由组 ${purpose} 没有可用服务，回落到内置配置`)
  }
  const stored = await db.getUserConfig(userId)
  const provider = stored?.provider
  const model = provider?.model || cfg.llm.model
  return withModelOverride(
    targetOfProvider({
      id: '',
      name: '',
      baseUrl: provider?.baseUrl || cfg.llm.baseUrl,
      apiKey: provider?.apiKey || cfg.llm.apiKey,
      model,
      proxy: provider?.proxy || '',
      ...(provider?.thinkingLevel ? { thinkingLevel: provider.thinkingLevel } : {}),
      ...(provider?.contextWindow ? { contextWindow: provider.contextWindow } : {}),
      ...(provider?.maxTokens ? { maxTokens: provider.maxTokens } : {})
    }),
    options?.model
  )
}
