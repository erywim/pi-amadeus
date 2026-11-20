import { Hono } from 'hono'
import { validateModelRuntimeOptions, type ResolvedModelRuntime, type UserConfig } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { defaultUserConfig } from '../conversation.ts'
import { resolveTarget } from '../runtime/model-dispatcher.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../llm.ts'

/** 用户级 AI 配置：SQLite user_configs 单一来源；未配置时回落 .env 默认 */

/** 掩码密钥：长度 ≤8 时整体打码，否则只露头尾各 4 位（响应永不回传完整密钥） */
function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  const tail = key.slice(-4)
  return `${key.slice(0, 4)}…${tail}`
}

/** 生效密钥状态（决定 UI 提示"使用默认/已配置/未配置"） */
export type ApiKeyStatus = 'default' | 'custom' | 'none'

export function configRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  app.get('/config/:userId/runtime', async (c) => {
    const target = await resolveTarget(cfg, db, c.req.param('userId'))
    const runtime: ResolvedModelRuntime = {
      providerId: target.providerId || null,
      providerName: target.providerName || null,
      model: target.model,
      contextWindow: target.contextWindow || DEFAULT_CONTEXT_WINDOW,
      maxTokens: target.maxTokens || DEFAULT_MAX_TOKENS,
      thinkingLevel: target.thinkingLevel ?? 'off'
    }
    return c.json(runtime)
  })

  app.get('/config/:userId', async (c) => {
    const stored = await db.getUserConfig(c.req.param('userId'))
    const merged: UserConfig = {
      ...defaultUserConfig(cfg),
      ...(stored ?? {})
    }
    const effectiveKey = merged.provider.apiKey || cfg.llm.apiKey
    const keyStatus: ApiKeyStatus = !effectiveKey
      ? 'none'
      : merged.provider.apiKey
        ? 'custom'
        : 'default'
    return c.json({
      config: { ...merged, provider: { ...merged.provider, apiKey: maskKey(effectiveKey) } },
      keyStatus
    })
  })

  app.put('/config/:userId', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { config?: unknown } | null
    if (!body?.config || typeof body.config !== 'object') {
      return c.json({ error: 'config 必填' }, 400)
    }
    const config = body.config as Partial<UserConfig>
    const error = validateModelRuntimeOptions(config) ||
      (config.provider !== undefined ? validateModelRuntimeOptions(config.provider) : undefined)
    if (error) return c.json({ error }, 400)
    const stored = await db.getUserConfig(c.req.param('userId'))
    const merged: UserConfig = {
      ...defaultUserConfig(cfg),
      ...(stored ?? {}),
      ...config,
      provider: {
        ...defaultUserConfig(cfg).provider,
        ...(stored?.provider ?? {}),
        ...(config.provider ?? {}),
        // apiKey 留空 = 不修改（表单不回填密钥，防止被掩码值覆盖）
        apiKey: config.provider?.apiKey?.trim() ? (config.provider.apiKey as string) : (stored?.provider?.apiKey ?? '')
      }
    }
    await db.setUserConfig(c.req.param('userId'), merged)
    return c.json({
      config: { ...merged, provider: { ...merged.provider, apiKey: maskKey(merged.provider.apiKey) } }
    })
  })

  return app
}
