import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { HttpBindings } from '@hono/node-server'
import { CollaborationManager, collaborationBody } from '../collaboration/manager.ts'

const loopbackHost = (host: string): boolean => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
const loopbackPeer = (peer: string): boolean => peer === '::1' || peer === '127.0.0.1' || peer === '::ffff:127.0.0.1'

/** 只挂在 loopback brain 上；LAN 网关绝不注册本机控制面。 */
export function collaborationRoutes(manager: CollaborationManager): Hono {
  const app = new Hono()
  app.use('/collaboration/*', async (c, next) => {
    const url = new URL(c.req.url)
    const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming
    const peer = incoming?.socket.remoteAddress
    if (!loopbackHost(url.hostname) || (peer && !loopbackPeer(peer))) {
      return c.json({ error: '协作设置只能从本机桌面端操作' }, 403)
    }
    const origin = c.req.header('Origin')
    if (origin) {
      let allowed = false
      try {
        const source = new URL(origin)
        allowed = source.protocol === 'http:' && loopbackHost(source.hostname)
      } catch { /* opaque/file Origin 与恶意网页不可区分，必须拒绝。 */ }
      if (!allowed) return c.json({ error: '不允许从此来源修改协作设置' }, 403)
    }
    if (c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: '不允许跨站访问协作设置' }, 403)
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.use('/collaboration/*', bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: '请求体不得超过 4 KiB' }, 413) }))
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    console.error('[collaboration] 本机操作失败', error)
    return c.json({ error: '协作操作失败，请检查本机日志' }, 500)
  })
  app.get('/collaboration/status', (c) => {
    const userId = c.req.query('userId') ?? ''
    if (userId.length > 128) return c.json({ error: 'userId 过长' }, 400)
    return c.json(manager.status(userId))
  })
  app.post('/collaboration/enable', async (c) => {
    const body = await collaborationBody(c.req.raw)
    if (body.port !== undefined && typeof body.port !== 'number') return c.json({ error: '端口必须为数字' }, 400)
    return c.json(await manager.enable(body.port as number | undefined))
  })
  app.post('/collaboration/disable', async (c) => {
    await collaborationBody(c.req.raw)
    await manager.disable()
    return c.json({ ok: true })
  })
  app.post('/collaboration/pairing', async (c) => {
    const body = await collaborationBody(c.req.raw)
    const role = body.role ?? 'observer'
    if (typeof body.userId !== 'string' || !body.userId.trim() || body.userId.length > 128) return c.json({ error: 'userId 必填，且不得超过 128 字符' }, 400)
    if (role !== 'observer' && role !== 'controller') return c.json({ error: '设备角色无效' }, 400)
    return c.json(manager.pairing(body.userId, role))
  })
  app.delete('/collaboration/devices/:id', (c) => {
    manager.revoke(c.req.param('id'))
    return c.json({ ok: true })
  })
  return app
}
