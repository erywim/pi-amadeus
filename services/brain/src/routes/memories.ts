import { Hono } from 'hono'
import type { MemoryItem, MemoryKind } from '@pi-amadeus/shared'
import type { Db, MemoryRow } from '../db.ts'
import { summarizeAffinity } from '../memory/index.ts'

const KINDS = new Set<MemoryKind>(['fact', 'preference', 'event', 'relationship'])

function toItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    pinned: row.pinned,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    sourceSessionId: row.sourceSessionId
  }
}

/** 长期记忆：列表/搜索、手动新增、编辑、置顶、删除；好感度汇总 */
export function memoryRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/memories', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const query = c.req.query('q') ?? ''
    const [rows, total] = await Promise.all([
      db.listMemories(userId, query),
      db.countMemories(userId)
    ])
    return c.json({ memories: rows.map(toItem), total })
  })

  app.post('/memories', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; content?: unknown; kind?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!userId || !content) return c.json({ error: 'userId/content 必填' }, 400)
    if (content.length > 500) return c.json({ error: 'content 最多 500 字' }, 400)
    const kindRaw = typeof body?.kind === 'string' ? body.kind : 'fact'
    const kind = KINDS.has(kindRaw as MemoryKind) ? (kindRaw as MemoryKind) : 'fact'
    const row = await db.addMemory({ userId, content, kind })
    return c.json({ ok: true, memory: toItem(row) })
  })

  app.patch('/memories/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { content?: unknown; kind?: unknown; pinned?: unknown }
      | null
    const patch: { content?: string; kind?: MemoryKind; pinned?: boolean } = {}
    if (typeof body?.content === 'string') {
      const content = body.content.trim()
      if (!content) return c.json({ error: 'content 不能为空' }, 400)
      if (content.length > 500) return c.json({ error: 'content 最多 500 字' }, 400)
      patch.content = content
    }
    if (typeof body?.kind === 'string' && KINDS.has(body.kind as MemoryKind)) {
      patch.kind = body.kind as MemoryKind
    }
    if (typeof body?.pinned === 'boolean') patch.pinned = body.pinned
    const row = await db.updateMemory(c.req.param('id'), patch)
    if (!row) return c.json({ error: '记忆不存在' }, 404)
    return c.json({ ok: true, memory: toItem(row) })
  })

  app.delete('/memories/:id', async (c) => {
    await db.deleteMemory(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get('/affinity', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    return c.json(await summarizeAffinity(db, userId))
  })

  return app
}
