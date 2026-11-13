import { Hono } from 'hono'
import type { PlatformItem, PlatformKind } from '@pi-amadeus/shared'
import type { Db, PlatformRow } from '../db.ts'
import { platformManager } from '../platforms/manager.ts'

const KINDS = new Set<PlatformKind>(['telegram', 'onebot', 'webhook', 'discord', 'slack'])

const FIELDS: Record<PlatformKind, string[]> = {
  telegram: ['token', 'baseUrl', 'testChatId'],
  onebot: ['url', 'accessToken', 'testChatId'],
  webhook: ['outboundUrl', 'secret'],
  discord: ['botToken', 'gatewayUrl', 'apiBaseUrl', 'testChatId'],
  slack: ['botToken', 'appToken', 'apiBaseUrl', 'testChatId']
}

/** 每个平台的密钥字段；编辑时留空表示保持原值 */
const SECRET_FIELDS: Record<PlatformKind, string[]> = {
  telegram: ['token'],
  onebot: ['accessToken'],
  webhook: ['secret'],
  discord: ['botToken'],
  slack: ['botToken', 'appToken']
}

/**
 * 通讯平台管理：列表/新增/编辑/删除/启停/测试 + 通用 Webhook 入站。
 * 密钥字段只进不出：响应里只回传 tokenSet / accessTokenSet / secretSet。
 */
export function platformRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/platforms', async (c) => {
    const rows = await db.listPlatforms()
    return c.json({ platforms: rows.map(toItem) })
  })

  app.post('/platforms', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const kind = typeof body?.kind === 'string' ? body.kind : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!KINDS.has(kind as PlatformKind)) return c.json({ error: '不支持的平台类型' }, 400)
    if (!name) return c.json({ error: 'name 必填' }, 400)
    const config = mergeConfig(kind as PlatformKind, {}, readConfig(body))
    const invalid = validate(kind as PlatformKind, config)
    if (invalid) return c.json({ error: invalid }, 400)
    const row = await db.createPlatform({
      kind: kind as PlatformKind,
      name,
      enabled: body?.enabled !== false,
      config
    })
    await platformManager.sync()
    return c.json({ ok: true, platform: toItem(row) })
  })

  app.patch('/platforms/:id', async (c) => {
    const row = await db.getPlatform(c.req.param('id'))
    if (!row) return c.json({ error: '平台不存在' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined
    const config = mergeConfig(row.kind, row.config, readConfig(body))
    const invalid = validate(row.kind, config)
    if (invalid) return c.json({ error: invalid }, 400)
    const updated = await db.updatePlatform(row.id, {
      ...(name ? { name } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      config
    })
    await platformManager.sync()
    return c.json({ ok: true, platform: toItem(updated!) })
  })

  app.delete('/platforms/:id', async (c) => {
    const row = await db.getPlatform(c.req.param('id'))
    if (!row) return c.json({ error: '平台不存在' }, 404)
    await db.deletePlatform(row.id)
    await platformManager.sync()
    return c.json({ ok: true })
  })

  app.put('/platforms/:id/enabled', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
    const row = await db.getPlatform(c.req.param('id'))
    if (!row) return c.json({ error: '平台不存在' }, 404)
    const updated = await db.updatePlatform(row.id, { enabled: body?.enabled === true })
    await platformManager.sync()
    return c.json({ ok: true, platform: toItem(updated!) })
  })

  app.post('/platforms/:id/test', async (c) => {
    const row = await db.getPlatform(c.req.param('id'))
    if (!row) return c.json({ error: '平台不存在' }, 404)
    const result = await platformManager.sendTest(row.id)
    if (!result.ok) return c.json({ error: result.error ?? '测试发送失败' }, 400)
    return c.json({ ok: true })
  })

  // 通用 Webhook 入站（平台外部系统调用；密钥可选）
  app.post('/platforms/:id/webhook', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: '请求体必须是 JSON' }, 400)
    const secret = c.req.header('x-amadeus-secret') ?? ''
    const result = await platformManager.handleWebhook(c.req.param('id'), body, secret)
    if (!result.ok) return c.json({ error: result.error }, result.status as 400)
    return c.json({ ok: true }, 202)
  })

  return app
}

function toItem(row: PlatformRow): PlatformItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    config: maskConfig(row.kind, row.config),
    status: platformManager.statusOf(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function maskConfig(kind: PlatformKind, config: Record<string, unknown>): Record<string, unknown> {
  const text = (key: string): string => (typeof config[key] === 'string' ? (config[key] as string) : '')
  switch (kind) {
    case 'telegram':
      return {
        baseUrl: text('baseUrl'),
        testChatId: text('testChatId'),
        tokenSet: text('token').length > 0
      }
    case 'onebot':
      return {
        url: text('url'),
        testChatId: text('testChatId'),
        accessTokenSet: text('accessToken').length > 0
      }
    case 'webhook':
      return {
        outboundUrl: text('outboundUrl'),
        secretSet: text('secret').length > 0
      }
    case 'discord':
      return {
        gatewayUrl: text('gatewayUrl'),
        apiBaseUrl: text('apiBaseUrl'),
        testChatId: text('testChatId'),
        botTokenSet: text('botToken').length > 0
      }
    case 'slack':
      return {
        apiBaseUrl: text('apiBaseUrl'),
        testChatId: text('testChatId'),
        botTokenSet: text('botToken').length > 0,
        appTokenSet: text('appToken').length > 0
      }
  }
}

function readConfig(body: Record<string, unknown> | null): Record<string, string> {
  const raw = body?.config
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const config: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') config[key] = value
  }
  return config
}

/** 合并配置：允许的字段才写入；密钥留空表示保持原值 */
function mergeConfig(
  kind: PlatformKind,
  existing: Record<string, unknown>,
  input: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const field of FIELDS[kind]) {
    const current = typeof existing[field] === 'string' ? (existing[field] as string) : ''
    merged[field] = current
  }
  for (const field of FIELDS[kind]) {
    const value = input[field]
    if (value === undefined) continue
    if (SECRET_FIELDS[kind].includes(field) && value.trim() === '') continue
    merged[field] = value.trim()
  }
  return merged
}

function validate(kind: PlatformKind, config: Record<string, string>): string | null {
  if (kind === 'telegram') {
    if (!config.token) return '缺少 Bot Token'
    const baseUrl = config.baseUrl
    if (baseUrl && !isHttpUrl(baseUrl)) return 'baseUrl 必须是 http(s) 地址'
    return null
  }
  if (kind === 'onebot') {
    if (!config.url) return '缺少 OneBot WebSocket 地址'
    if (!/^wss?:\/\//.test(config.url)) return '地址必须以 ws:// 或 wss:// 开头'
    return null
  }
  if (kind === 'discord') {
    if (!config.botToken) return '缺少 Bot Token'
    if (config.gatewayUrl && !/^wss?:\/\//.test(config.gatewayUrl)) {
      return 'Gateway 地址必须以 ws:// 或 wss:// 开头'
    }
    if (config.apiBaseUrl && !isHttpUrl(config.apiBaseUrl)) return 'API 地址必须是 http(s) 地址'
    if (config.testChatId && !/^\d+$/.test(config.testChatId)) return '测试频道 ID 必须是数字'
    return null
  }
  if (kind === 'slack') {
    if (!config.botToken) return '缺少 Bot Token（xoxb）'
    if (!config.appToken) return '缺少 App Token（xapp，需开启 Socket Mode）'
    if (config.apiBaseUrl && !isHttpUrl(config.apiBaseUrl)) return 'API 地址必须是 http(s) 地址'
    return null
  }
  if (!config.outboundUrl) return '缺少出站地址（outboundUrl）'
  if (!isHttpUrl(config.outboundUrl)) return '出站地址必须是 http(s) 地址'
  return null
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
