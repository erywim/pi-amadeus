import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { HttpBindings } from '@hono/node-server'
import { RelayManager, type RelaySettingsInput } from '../relay/manager.ts'

const loopbackHost = (host: string): boolean => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
const loopbackPeer = (peer: string): boolean => peer === '::1' || peer === '127.0.0.1' || peer === '::ffff:127.0.0.1'

/** 空 body 合法；带 body 时必须是 JSON 对象，且任何字段都不会被当作 Relay 配置。 */
async function relayBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new HTTPException(415, { message: '请使用 application/json' })
  }
  const value: unknown = await request.json().catch(() => {
    throw new HTTPException(400, { message: 'JSON 格式无效' })
  })
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPException(400, { message: '请求必须是 JSON 对象' })
  }
  return value as Record<string, unknown>
}

/** Relay 控制面只服务本机桌面端；配置只来自环境变量，绝不从请求体读取。 */
export function relayRoutes(manager: RelayManager): Hono {
  const app = new Hono()
  app.use('/relay/*', async (c, next) => {
    const url = new URL(c.req.url)
    const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming
    const peer = incoming?.socket.remoteAddress
    // 与协作网关一致：Host 与真实对端都必须是本机回环，绝不信任转发头。
    if (!loopbackHost(url.hostname) || (peer && !loopbackPeer(peer))) {
      return c.json({ error: 'Relay 设置只能从本机桌面端操作' }, 403)
    }
    const origin = c.req.header('Origin')
    if (origin) {
      let allowed = false
      try {
        const source = new URL(origin)
        allowed = source.protocol === 'http:' && loopbackHost(source.hostname)
      } catch { /* opaque/file Origin 与恶意网页不可区分，必须拒绝。 */ }
      if (!allowed) return c.json({ error: '不允许从此来源修改 Relay 设置' }, 403)
    }
    if (c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: '不允许跨站访问 Relay 设置' }, 403)
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.use('/relay/*', bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: '请求体不得超过 4 KiB' }, 413) }))
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    console.error('[relay] 本机操作失败', error)
    return c.json({ error: 'Relay 操作失败，请检查本机日志' }, 500)
  })
  app.get('/relay/status', (c) => c.json(manager.status()))
  app.post('/relay/enable', async (c) => {
    const body = await relayBody(c.req.raw)
    const allowed = new Set(['serverUrl', 'connectCode', 'registrationKey', 'e2eEncryption', 'deviceName', 'userId'])
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return c.json({ error: '请求包含不支持的 Relay 字段' }, 400)
    }
    if (body.e2eEncryption !== undefined && typeof body.e2eEncryption !== 'boolean') {
      return c.json({ error: 'e2eEncryption 必须是布尔值' }, 400)
    }
    for (const key of ['serverUrl', 'connectCode', 'registrationKey', 'deviceName', 'userId'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') return c.json({ error: `${key} 必须是字符串` }, 400)
    }
    if (body.userId !== undefined && (body.userId as string).length > 128) return c.json({ error: 'userId 过长' }, 400)
    return c.json(await manager.enable(body as RelaySettingsInput))
  })
  app.post('/relay/disable', async (c) => {
    await relayBody(c.req.raw)
    await manager.disable()
    return c.json({ ok: true })
  })
  app.post('/relay/reconnect', async (c) => {
    await relayBody(c.req.raw)
    return c.json(await manager.reconnect())
  })
  return app
}
