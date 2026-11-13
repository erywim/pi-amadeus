import { Hono } from 'hono'
import type { Message, Session, SessionMessages, WorldlineSummary } from '@pi-amadeus/shared'
import type { Db, MessageRow } from '../db.ts'
import { latestLeafUnder, siblingIdsOf, worldlineStateOf, worldlinesOf } from '../worldline.ts'

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

  /** 活动世界线（一条从根到活动叶的路径）+ 世界线元信息 */
  app.get('/sessions/:id/messages', async (c) => {
    return c.json(await messagePage(db, c.req.param('id')))
  })

  /**
   * 世界线跳跃 / 回退：
   * - toLeaf=true：跳到该消息所在支路的**最新状态**（点兄弟箭头切换世界线用）
   * - 省略：把活动叶精确设到这条消息（回退，之后发消息会从分叉出一条新世界线）
   */
  app.post('/sessions/:id/head', async (c) => {
    const sessionId = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as
      | { messageId?: unknown; toLeaf?: unknown }
      | null
    const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
    if (!messageId) return c.json({ error: 'messageId 必填' }, 400)

    const tree = await db.listMessageTree(sessionId)
    if (!tree.some((node) => node.id === messageId)) {
      return c.json({ error: '消息不属于该会话' }, 404)
    }
    const target = body?.toLeaf === true ? latestLeafUnder(tree, messageId) : tree.find((n) => n.id === messageId)
    if (!target) return c.json({ error: '目标世界线不存在' }, 404)

    await db.setActiveMessage(sessionId, target.id)
    // 压缩摘要属于跳转前那条世界线：跳线后作废（跨世界线保留的只有长期记忆）
    await db.clearCompaction(sessionId)
    return c.json(await messagePage(db, sessionId))
  })

  /** 世界线列表（跳转面板）：叶子、序号、变动率、末句预览 */
  app.get('/sessions/:id/worldlines', async (c) => {
    const sessionId = c.req.param('id')
    const [tree, head, rows] = await Promise.all([
      db.listMessageTree(sessionId),
      db.getActiveMessageId(sessionId),
      db.listMessages(sessionId)
    ])
    const effectiveHead = head ?? rows.at(-1)?.id ?? null
    const entries = worldlinesOf(tree, effectiveHead)
    const leaves = await db.listMessagesByIds(entries.map((entry) => entry.leafId))
    const byId = new Map(leaves.map((row) => [row.id, row]))
    const worldlines: WorldlineSummary[] = entries.map((entry) => ({
      leafId: entry.leafId,
      index: entry.index,
      divergence: entry.divergence,
      updatedAt: entry.updatedAt,
      active: entry.active,
      preview: previewOf(byId.get(entry.leafId))
    }))
    return c.json({ worldlines })
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

/** 活动世界线 + 世界线元信息（消息上带兄弟列表，UI 据此画分叉箭头） */
async function messagePage(db: Db, sessionId: string): Promise<SessionMessages> {
  const [rows, tree, head] = await Promise.all([
    db.listMessages(sessionId),
    db.listMessageTree(sessionId),
    db.getActiveMessageId(sessionId)
  ])
  // 老数据没有活动叶记录时，以实际读到的路径末端为准，避免两边不一致
  const effectiveHead = head ?? rows.at(-1)?.id ?? null
  const state = worldlineStateOf(tree, effectiveHead)
  const messages: Message[] = rows.map((row) => {
    const siblings = siblingIdsOf(tree, row.id)
    return {
      ...row,
      // 只有真的分过叉才带兄弟列表（单链时不增加载荷）
      ...(siblings.length > 1 ? { siblingIds: siblings } : {})
    }
  })
  return {
    messages,
    worldline: {
      headId: state.headId,
      index: state.index,
      total: state.total,
      divergence: state.divergence,
      rewound: state.rewound
    }
  }
}

/** 世界线预览：末条消息的单行摘要 */
function previewOf(row: MessageRow | undefined): string {
  if (!row) return ''
  const text = row.content.replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
