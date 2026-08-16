import { randomInt } from 'node:crypto'
import { Hono } from 'hono'
import type { Db } from '../db.ts'

/** 用户身份：桌面登录名解析 + 飞书绑定码 */
export function userRoutes(db: Db): Hono {
  const app = new Hono()

  app.post('/users/resolve', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { username?: unknown } | null
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    if (!username) return c.json({ error: 'username 必填' }, 400)
    const { id } = await db.resolveUser(username)
    return c.json({ userId: id })
  })

  // 飞书绑定码：AMADEUS-XXXX，飞书侧发该码完成身份绑定
  app.get('/users/:id/bind-code', async (c) => {
    const user = await db.getUser(c.req.param('id'))
    if (!user) return c.json({ error: 'user not found' }, 404)
    let code = user.bindCode
    if (!code) {
      code = `AMADEUS-${randomInt(1000, 10000)}`
      await db.setBindCode(user.id, code)
    }
    return c.json({ bindCode: code })
  })

  return app
}
