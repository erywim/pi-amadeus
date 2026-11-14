import type { ProviderInput, ProviderItem, ProviderTestResult, ThinkingLevel } from '@pi-amadeus/shared'
import { validateModelRuntimeOptions } from '@pi-amadeus/shared'
import type { Db, ProviderRow } from '../db.ts'
import { completeText, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, shouldCooldownProvider, supportsVision, type LlmTarget } from '../llm.ts'
import { isProviderCoolingDown, markProviderFailure, markProviderSuccess } from './failover.ts'

/**
 * 模型服务注册表：密钥只进不出（列表接口只回传 apiKeySet），
 * 测试连接会真的发一次最小请求——通过与否都以真实响应为准。
 */

const ROUTE_TAGS = new Set(['chat', 'vision', 'summary', 'memory'])
export function parseThinkingLevel(value: string | undefined): ThinkingLevel {
  const error = validateModelRuntimeOptions({ thinkingLevel: value })
  if (error) throw new Error(error)
  return (value ?? 'off') as ThinkingLevel
}

export function parseTags(tags: string): string[] {
  const list = tags
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => ROUTE_TAGS.has(tag))
  return list.length > 0 ? [...new Set(list)] : ['chat']
}

function startOfToday(): number {
  const date = new Date()
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function toProviderItem(row: ProviderRow, todayTokens = 0): ProviderItem {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    proxy: row.proxy,
    enabled: row.enabled,
    active: row.active,
    priority: row.priority,
    tags: parseTags(row.tags),
    dailyTokenQuota: row.dailyTokenQuota,
    thinkingLevel: parseThinkingLevel(row.thinkingLevel),
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    todayTokens,
    quotaExceeded: row.dailyTokenQuota > 0 && todayTokens >= row.dailyTokenQuota,
    apiKeySet: row.apiKey.trim().length > 0,
    coolingDown: isProviderCoolingDown(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

async function withUsage(db: Db, row: ProviderRow): Promise<ProviderItem> {
  // 即使配额不限也显示真实用量，避免“0 tokens”被误读成没跑过
  const usage = await db.providerUsageToday(row.id, startOfToday())
  return toProviderItem(row, usage)
}

export async function listProviderItems(db: Db): Promise<ProviderItem[]> {
  const rows = await db.listProviders()
  return Promise.all(rows.map((row) => withUsage(db, row)))
}

export async function createProviderItem(
  db: Db,
  input: ProviderInput
): Promise<{ ok: true; provider: ProviderItem } | { ok: false; error: string }> {
  const validated = validate(input)
  if (!validated.ok) return validated
  const maxPriority = (await db.listProviders()).reduce(
    (max, provider) => Math.max(max, provider.priority),
    0
  )
  const row = await db.createProvider({
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: (input.apiKey ?? '').trim(),
    model: input.model.trim(),
    proxy: (input.proxy ?? '').trim(),
    tags: parseTags((input.tags ?? ['chat']).join(',')).join(','),
    dailyTokenQuota: Math.max(0, Math.floor(input.dailyTokenQuota ?? 0)),
    thinkingLevel: parseThinkingLevel(input.thinkingLevel),
    contextWindow: input.contextWindow ?? 0,
    maxTokens: input.maxTokens ?? 0,
    enabled: input.enabled !== false,
    priority: input.priority ?? maxPriority + 10
  })
  return { ok: true, provider: await withUsage(db, row) }
}

export async function updateProviderItem(
  db: Db,
  id: string,
  input: ProviderInput
): Promise<{ ok: true; provider: ProviderItem } | { ok: false; error: string; notFound?: boolean }> {
  const existing = await db.getProvider(id)
  if (!existing) return { ok: false, error: '模型服务不存在', notFound: true }
  const validated = validate({ ...input, apiKey: input.apiKey || existing.apiKey })
  if (!validated.ok) return validated
  const updated = await db.updateProvider(id, {
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    // 留空表示保持原密钥：避免编辑名称/模型时把密钥清掉
    ...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
    model: input.model.trim(),
    proxy: (input.proxy ?? '').trim(),
    ...(input.tags !== undefined
      ? { tags: parseTags(input.tags.join(',')).join(',') }
      : {}),
    ...(input.dailyTokenQuota !== undefined
      ? { dailyTokenQuota: Math.max(0, Math.floor(input.dailyTokenQuota)) }
      : {}),
    ...(input.thinkingLevel !== undefined
      ? { thinkingLevel: parseThinkingLevel(input.thinkingLevel) }
      : {}),
    ...(input.contextWindow !== undefined
      ? { contextWindow: input.contextWindow }
      : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {})
  })
  // 保存新配置后从冷却恢复为可选，让修正端点/密钥/运行参数的下一次请求立即生效。
  if (updated) markProviderSuccess(id)
  return updated
    ? { ok: true, provider: await withUsage(db, updated) }
    : { ok: false, error: '更新失败' }
}

export async function activateProvider(
  db: Db,
  id: string
): Promise<{ ok: true; provider: ProviderItem } | { ok: false; error: string; notFound?: boolean }> {
  const existing = await db.getProvider(id)
  if (!existing) return { ok: false, error: '模型服务不存在', notFound: true }
  if (!existing.apiKey.trim()) return { ok: false, error: '该服务还没有配置密钥' }
  await db.setActiveProvider(id)
  const provider = await db.getProvider(id)
  return provider
    ? { ok: true, provider: await withUsage(db, provider) }
    : { ok: false, error: '激活失败' }
}

export async function deleteProviderItem(db: Db, id: string): Promise<boolean> {
  const existing = await db.getProvider(id)
  if (!existing) return false
  await db.deleteProvider(id)
  return true
}

/** 用服务配置真的发一次最小补全；返回延迟与模型回显 */
export async function testProvider(db: Db, id: string): Promise<ProviderTestResult> {
  const row = await db.getProvider(id)
  if (!row) return { ok: false, error: '模型服务不存在' }
  if (!row.apiKey.trim()) return { ok: false, error: '还没有配置密钥' }
  const target: LlmTarget = {
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: row.model,
    vision: supportsVision(row.model),
    proxy: row.proxy,
    // 连通性测试只验证端点/密钥，不请求思考（否则推理预算会拖慢测试并可能空回复）
    contextWindow: row.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxTokens: row.maxTokens || DEFAULT_MAX_TOKENS
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  const startedAt = Date.now()
  try {
    const reply = await completeText(
      target,
      {
        systemPrompt: '你是连通性测试助手。',
        messages: [{ role: 'user', content: '只回复 OK 两个字符。', timestamp: Date.now() }]
      },
      { signal: controller.signal, maxTokens: 16, temperature: 0, thinkingLevel: 'off' }
    )
    const trimmed = reply.trim()
    // 空回复按失败处理：不可达端点在部分客户端里会「成功」返回空流，
    // 把它当成连通会把真正的坏服务留在池子里
    if (!trimmed) throw new Error('服务返回了空内容')
    markProviderSuccess(row.id)
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      reply: trimmed.slice(0, 40)
    }
  } catch (error) {
    // 测试与回合一致：只有真实服务故障进入冷却，参数 400/输出截断保留原错误。
    if (shouldCooldownProvider(error)) markProviderFailure(row.id)
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

function validate(input: ProviderInput): { ok: true } | { ok: false; error: string } {
  const error = validateModelRuntimeOptions(input)
  if (error) return { ok: false, error }
  if (!input.name?.trim()) return { ok: false, error: 'name 必填' }
  if (!input.model?.trim()) return { ok: false, error: 'model 必填' }
  const baseUrl = input.baseUrl?.trim()
  if (!baseUrl) return { ok: false, error: 'baseUrl 必填' }
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'baseUrl 必须是 http(s) 地址' }
    }
  } catch {
    return { ok: false, error: 'baseUrl 不是合法 URL' }
  }
  return { ok: true }
}
