import { Hono } from 'hono'
import type { MessageSearchHit, Session } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'

/** 会话与消息读取：列表 / 详情 / 删除 / 搜索 / 用量（创建是懒的——首条消息时由 chat/voice 落行） */
export function sessionRoutes(db: Db): Hono {
  const app = new Hono()

  const toSession = (r: Awaited<ReturnType<Db['listSessions']>>[number]): Session => ({
    id: r.id,
    channel: r.channel,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    pinned: r.pinned,
    messageCount: r.messageCount
  })

  app.get('/sessions', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const rows = await db.listSessions(userId)
    return c.json({ sessions: rows.map(toSession) })
  })

  /** 跨会话全文搜索：标题之外的正文命中，侧栏搜索用 */
  app.get('/sessions/search', async (c) => {
    const userId = c.req.query('userId') ?? ''
    const query = (c.req.query('q') ?? '').trim()
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    if (!query) return c.json({ hits: [] })
    const rows = await db.searchMessages(userId, query, 30)
    const hits: MessageSearchHit[] = rows.map((row) => ({
      sessionId: row.sessionId,
      sessionTitle: row.sessionTitle,
      channel: row.channel,
      messageId: row.messageId,
      role: row.role,
      snippet: snippetOf(row.content, query),
      createdAt: row.createdAt
    }))
    return c.json({ hits })
  })

  app.get('/sessions/:id/messages', async (c) => {
    const rows = await db.listMessages(c.req.param('id'))
    return c.json({ messages: rows })
  })

  /** 会话级 token 用量：turn_metrics 的真实累计（没跑过回合就是 0） */
  app.get('/sessions/:id/usage', async (c) => {
    return c.json(await db.sessionUsage(c.req.param('id')))
  })

  /**
   * 重命名 / 置顶。
   * - 重命名只改标题、不刷新 updated_at（重命名会把旧会话顶到最前）
   * - 置顶同理：只改 pinned，列表里置顶优先
   * - 空会话（尚未落库）重命名时按 userId 补建
   */
  app.patch('/sessions/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { title?: unknown; pinned?: unknown; userId?: unknown; channel?: unknown }
      | null
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const hasPinned = typeof body?.pinned === 'boolean'
    const pinned = hasPinned ? (body!.pinned as boolean) : undefined
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    if (!title && !hasPinned) return c.json({ error: 'title 或 pinned 必填' }, 400)
    if (title.length > 80) return c.json({ error: 'title 最多 80 字' }, 400)

    const id = c.req.param('id')
    const session = await db.getSession(id)
    if (session) {
      // 有 userId 时校验归属：不能改别人的会话
      if (userId && session.userId !== userId) return c.json({ error: '无权修改该会话' }, 403)
      if (title) await db.renameSession(id, title)
      if (pinned !== undefined) await db.setSessionPinned(id, pinned)
      return c.json({ ok: true, ...(title ? { title } : {}), ...(pinned !== undefined ? { pinned } : {}) })
    }
    // 新会话是懒创建的（首条消息才落库）：空会话重命名 / 置顶时按当前身份补建，
    // 否则用户给刚开的会话改名或置顶会得到一个没头没脑的 404
    if (!userId || !(await db.getUser(userId))) return c.json({ error: '会话不存在' }, 404)
    const channel = body?.channel === 'feishu' ? 'feishu' : 'desktop'
    await db.touchSession({ id, userId, channel })
    if (title) await db.renameSession(id, title)
    if (pinned !== undefined) await db.setSessionPinned(id, pinned)
    return c.json({
      ok: true,
      ...(title ? { title } : {}),
      ...(pinned !== undefined ? { pinned } : {})
    })
  })

  app.delete('/sessions/:id', async (c) => {
    await db.deleteSession(c.req.param('id'))
    return c.json({ ok: true })
  })

  return app
}

/** 命中位置前后各 40 字（不区分大小写；找不到时取开头） */
function snippetOf(content: string, query: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const index = flat.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return flat.slice(0, 120)
  const start = Math.max(0, index - 40)
  const end = Math.min(flat.length, index + query.length + 40)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
