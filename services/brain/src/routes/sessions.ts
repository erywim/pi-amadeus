import { Hono } from 'hono'
import type { Session } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'

/** 会话与消息读取：列表 / 详情 / 删除（创建是懒的——首条消息时由 chat/voice 落行） */
export function sessionRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/sessions', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const rows = await db.listSessions(userId)
    const sessions: Session[] = rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r.messageCount
    }))
    return c.json({ sessions })
  })

  app.get('/sessions/:id/messages', async (c) => {
    const rows = await db.listMessages(c.req.param('id'))
    return c.json({ messages: rows })
  })

  // 手动重命名：只改标题，不刷新 updated_at（否则重命名会把旧会话顶到列表最前）
  app.patch('/sessions/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { title?: unknown; userId?: unknown; channel?: unknown }
      | null
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    if (!title) return c.json({ error: 'title 必填' }, 400)
    if (title.length > 80) return c.json({ error: 'title 最多 80 字' }, 400)
    const id = c.req.param('id')
    const session = await db.getSession(id)
    if (session) {
      // 有 userId 时校验归属：不能改别人的会话标题
      if (userId && session.userId !== userId) return c.json({ error: '无权修改该会话' }, 403)
      await db.renameSession(id, title)
      return c.json({ ok: true, title })
    }
    // 新会话是懒创建的（首条消息才落库）：空会话重命名时按当前身份补建，
    // 否则用户给刚开的会话改名会得到一个没头没脑的 404
    if (!userId || !(await db.getUser(userId))) return c.json({ error: '会话不存在' }, 404)
    const channel = body?.channel === 'feishu' ? 'feishu' : 'desktop'
    await db.touchSession({ id, userId, channel })
    await db.renameSession(id, title)
    return c.json({ ok: true, title })
  })

  app.delete('/sessions/:id', async (c) => {
    await db.deleteSession(c.req.param('id'))
    return c.json({ ok: true })
  })

  return app
}
