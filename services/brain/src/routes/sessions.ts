import { unlinkSync } from 'node:fs'
import { Hono } from 'hono'
import type { BranchTreeNode, BranchTreeResponse, MessageSearchHit, Session } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'
import { toPublicMessage } from '../media.ts'

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
    archived: r.archived,
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
    return c.json({ messages: rows.map(toPublicMessage) })
  })

  /**
   * 完整消息树（所有分支）：分支树弹窗用。
   * active 标出当前活跃路径；其余节点是保留下来但当前看不到的旧分支。
   */
  app.get('/sessions/:id/tree', async (c) => {
    const id = c.req.param('id')
    const session = await db.getSession(id)
    if (!session) return c.json({ error: '会话不存在' }, 404)
    const [rows, activeLeafId] = await Promise.all([
      db.listAllMessages(id),
      db.getActiveLeafId(id)
    ])
    const parentOf = new Map(rows.map((row) => [row.id, row.parentId]))
    const active = new Set<string>()
    let cursor = activeLeafId
    for (let depth = 0; cursor && depth < 5000; depth += 1) {
      if (active.has(cursor)) break
      active.add(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
    const nodes: BranchTreeNode[] = rows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      role: row.role,
      preview: previewOf(row.content),
      createdAt: row.createdAt,
      branchIndex: row.branchIndex,
      branchCount: row.branchCount,
      active: active.has(row.id)
    }))
    const response: BranchTreeResponse = { activeLeafId, nodes }
    return c.json(response)
  })

  /** 跳到某条消息所在分支的最新后代（分支树点节点 = 切到那条分支继续） */
  app.post('/sessions/:id/active-leaf', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; messageId?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
    const sessionId = c.req.param('id')
    if (!userId || !messageId) return c.json({ error: 'userId/messageId 必填' }, 400)
    const session = await db.getSession(sessionId)
    if (!session || session.userId !== userId) return c.json({ error: '会话不存在' }, 404)
    const target = await db.getMessage(messageId)
    if (!target || target.sessionId !== sessionId) return c.json({ error: '消息不存在' }, 404)
    const leaf = await db.lastDescendant(messageId)
    await db.setActiveLeaf(sessionId, leaf)
    return c.json({ ok: true, activeLeafId: leaf })
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
      | { title?: unknown; pinned?: unknown; archived?: unknown; userId?: unknown; channel?: unknown }
      | null
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const hasPinned = typeof body?.pinned === 'boolean'
    const pinned = hasPinned ? (body!.pinned as boolean) : undefined
    const hasArchived = typeof body?.archived === 'boolean'
    const archived = hasArchived ? (body!.archived as boolean) : undefined
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    if (!title && !hasPinned && !hasArchived) return c.json({ error: 'title / pinned / archived 必填' }, 400)
    if (title.length > 80) return c.json({ error: 'title 最多 80 字' }, 400)

    const id = c.req.param('id')
    const session = await db.getSession(id)
    if (session) {
      // 有 userId 时校验归属：不能改别人的会话
      if (userId && session.userId !== userId) return c.json({ error: '无权修改该会话' }, 403)
      if (title) await db.renameSession(id, title)
      if (pinned !== undefined) await db.setSessionPinned(id, pinned)
      if (archived !== undefined) await db.setSessionArchived(id, archived)
      return c.json({
        ok: true,
        ...(title ? { title } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(archived !== undefined ? { archived } : {})
      })
    }
    // 新会话是懒创建的（首条消息才落库）：空会话重命名 / 置顶时按当前身份补建，
    // 否则用户给刚开的会话改名或置顶会得到一个没头没脑的 404
    if (!userId || !(await db.getUser(userId))) return c.json({ error: '会话不存在' }, 404)
    const channel = body?.channel === 'feishu' ? 'feishu' : 'desktop'
    await db.touchSession({ id, userId, channel })
    if (title) await db.renameSession(id, title)
    if (pinned !== undefined) await db.setSessionPinned(id, pinned)
    if (archived !== undefined) await db.setSessionArchived(id, archived)
    return c.json({
      ok: true,
      ...(title ? { title } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(archived !== undefined ? { archived } : {})
    })
  })

  /**
   * 切换分支：messageId 是当前路径上的某条消息，direction = -1/1。
   * 找到它的兄弟消息，切到相邻分支；新活跃叶是该分支的最新后代。
   */
  app.post('/sessions/:id/branch', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; messageId?: unknown; direction?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
    const direction = Number(body?.direction) < 0 ? -1 : 1
    const sessionId = c.req.param('id')
    if (!userId || !messageId) return c.json({ error: 'userId/messageId 必填' }, 400)
    const session = await db.getSession(sessionId)
    if (!session || session.userId !== userId) return c.json({ error: '会话不存在' }, 404)
    const target = await db.getMessage(messageId)
    if (!target || target.sessionId !== sessionId) return c.json({ error: '消息不存在' }, 404)
    const siblings = await db.listBranches(messageId)
    if (siblings.length <= 1) return c.json({ error: '这条消息没有其他分支' }, 400)
    const index = siblings.findIndex((item) => item.id === messageId)
    const next = siblings[Math.min(siblings.length - 1, Math.max(0, index + direction))]
    if (!next) return c.json({ error: '分支切换失败' }, 400)
    const leaf = await db.lastDescendant(next.id)
    await db.setActiveLeaf(sessionId, leaf)
    return c.json({
      ok: true,
      activeMessageId: leaf,
      branchIndex: next.branchIndex,
      branchCount: next.branchCount
    })
  })

  /**
   * 删除会话：先取该会话所有附件的磁盘路径，删库（消息/附件元数据级联删除），
   * 再清理文件本体——否则每删一个带附件的会话就在数据目录里留下孤儿文件。
   * 文件删除失败不影响接口结果（元数据已经没了，重删也不会再找到它们）。
   */
  app.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const files = await db.sessionMediaPaths(id).catch(() => [] as string[])
    await db.deleteSession(id)
    for (const file of files) {
      try {
        unlinkSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[sessions] 附件文件清理失败 ${file}：`, error instanceof Error ? error.message : error)
        }
      }
    }
    return c.json({ ok: true })
  })

  return app
}

/** 分支树节点预览：压成一行，去掉常见的 Markdown 记号 */
function previewOf(content: string): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[#>*_`~()|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat
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
