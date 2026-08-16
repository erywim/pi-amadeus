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

  app.delete('/sessions/:id', async (c) => {
    await db.deleteSession(c.req.param('id'))
    return c.json({ ok: true })
  })

  return app
}
