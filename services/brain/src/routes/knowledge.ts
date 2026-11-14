import { Hono } from 'hono'
import type { KnowledgeBase, KnowledgeDoc } from '@pi-amadeus/shared'
import type { Db, KnowledgeBaseRow, KnowledgeDocRow } from '../db.ts'
import { DOC_MAX_CHARS, importKnowledgeDoc, searchKnowledge } from '../knowledge/index.ts'
import { readPublicPage } from '../tools/fetchUrl.ts'

/** 知识库：增删改查 + 文档导入（粘贴 / 上传 / URL）+ 检索预览 */
export function knowledgeRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/knowledge', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const bases = await db.listKnowledgeBases(userId)
    return c.json({
      bases: bases.map(toBaseItem),
      totals: {
        docs: bases.reduce((sum, base) => sum + base.docCount, 0),
        chunks: bases.reduce((sum, base) => sum + base.chunkCount, 0)
      }
    })
  })

  app.post('/knowledge', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; name?: unknown; description?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!userId || !name) return c.json({ error: 'userId/name 必填' }, 400)
    if (name.length > 60) return c.json({ error: '知识库名称最多 60 字' }, 400)
    const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 300) : ''
    const base = await db.createKnowledgeBase({ userId, name, description })
    return c.json({ ok: true, base: toBaseItem(base) })
  })

  app.patch('/knowledge/:id', async (c) => {
    const base = await requireBase(db, c.req.param('id'), c.req.query('userId') ?? '')
    if (!base.ok) return c.json({ error: base.error }, base.status as 400)
    const body = (await c.req.json().catch(() => null)) as
      | { name?: unknown; description?: unknown }
      | null
    const patch: { name?: string; description?: string } = {}
    if (typeof body?.name === 'string') {
      const name = body.name.trim()
      if (!name) return c.json({ error: '名称不能为空' }, 400)
      if (name.length > 60) return c.json({ error: '名称最多 60 字' }, 400)
      patch.name = name
    }
    if (typeof body?.description === 'string') patch.description = body.description.trim().slice(0, 300)
    const updated = await db.updateKnowledgeBase(base.base.id, patch)
    return c.json({ ok: true, base: toBaseItem(updated!) })
  })

  app.delete('/knowledge/:id', async (c) => {
    const base = await requireBase(db, c.req.param('id'), c.req.query('userId') ?? '')
    if (!base.ok) return c.json({ error: base.error }, base.status as 400)
    await db.deleteKnowledgeBase(base.base.id)
    return c.json({ ok: true })
  })

  app.get('/knowledge/:id/docs', async (c) => {
    const base = await requireBase(db, c.req.param('id'), c.req.query('userId') ?? '')
    if (!base.ok) return c.json({ error: base.error }, base.status as 400)
    const docs = await db.listKnowledgeDocs(base.base.id)
    return c.json({ docs: docs.map(toDocItem) })
  })

  /**
   * 导入文档：
   * - application/json：{ name, content, source? }（粘贴文本）
   * - multipart/form-data：file + name?（上传 txt / md / json / csv 等纯文本）
   * 二进制文档（PDF / DOCX）不在本轮范围，会明确拒绝而不是把乱码塞进库。
   */
  app.post('/knowledge/:id/docs', async (c) => {
    const base = await requireBase(db, c.req.param('id'), c.req.query('userId') ?? '')
    if (!base.ok) return c.json({ error: base.error }, base.status as 400)
    const contentType = c.req.header('content-type') ?? ''

    let name = ''
    let content = ''
    let source = ''
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.parseBody()
      const file = form.file
      if (!(file instanceof File)) return c.json({ error: '缺少文件（file）' }, 400)
      if (file.size > DOC_MAX_CHARS * 4) {
        return c.json({ error: '文件过大（上限约 400K 字符）' }, 400)
      }
      name = typeof form.name === 'string' && form.name.trim() ? form.name.trim() : file.name
      content = await file.text()
      source = file.name
    } else {
      const body = (await c.req.json().catch(() => null)) as
        | { name?: unknown; content?: unknown; source?: unknown }
        | null
      name = typeof body?.name === 'string' ? body.name.trim() : ''
      content = typeof body?.content === 'string' ? body.content : ''
      source = typeof body?.source === 'string' ? body.source.trim() : '粘贴导入'
      if (!content.trim()) return c.json({ error: 'content 必填' }, 400)
    }

    if (looksBinary(content)) {
      return c.json(
        { error: '看起来是二进制文件（PDF/DOCX 等暂不支持），请先转成纯文本再导入' },
        400
      )
    }
    try {
      const doc = await importKnowledgeDoc(db, {
        kbId: base.base.id,
        name: name || '未命名文档',
        content,
        source
      })
      return c.json({ ok: true, doc: toDocItem({ ...doc, kbId: base.base.id }) })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  /** 从 URL 导入：抓取网页/纯文本，去标签后入知识库 */
  app.post('/knowledge/:id/import-url', async (c) => {
    const base = await requireBase(db, c.req.param('id'), c.req.query('userId') ?? '')
    if (!base.ok) return c.json({ error: base.error }, base.status as 400)
    const body = (await c.req.json().catch(() => null)) as { url?: unknown; name?: unknown } | null
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!/^https?:\/\//i.test(rawUrl)) return c.json({ error: '请输入 http(s) 地址' }, 400)

    try {
      const page = await readPublicPage(rawUrl, {
        signal: c.req.raw.signal,
        maxBytes: DOC_MAX_CHARS * 4,
        maxChars: DOC_MAX_CHARS
      })
      // 抓取已截断时从读取转为拒绝导入，不能把半篇文档当作完整知识来源持久化。
      if (page.truncated) return c.json({ error: '页面内容过大，已截断；请缩小内容后重新导入' }, 400)
      const finalUrl = new URL(page.url)
      const name =
        typeof body?.name === 'string' && body.name.trim()
          ? body.name.trim()
          : finalUrl.hostname + finalUrl.pathname
      const doc = await importKnowledgeDoc(db, {
        kbId: base.base.id,
        name,
        content: page.text,
        source: page.url
      })
      return c.json({ ok: true, doc: toDocItem({ ...doc, kbId: base.base.id }) })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.delete('/knowledge/docs/:docId', async (c) => {
    await db.deleteKnowledgeDoc(c.req.param('docId'))
    return c.json({ ok: true })
  })

  /** 检索预览：知识库页里「搜一下」用，也是 agent 工具同一套检索 */
  app.get('/knowledge/:id/search', async (c) => {
    const base = await requireBase(db, c.req.param('id'), c.req.query('userId') ?? '')
    if (!base.ok) return c.json({ error: base.error }, base.status as 400)
    const query = c.req.query('q') ?? ''
    if (!query.trim()) return c.json({ hits: [] })
    const hits = await searchKnowledge(db, base.base.userId, query, {
      kb: base.base.id,
      limit: 6
    })
    return c.json({ hits })
  })

  return app
}

function toBaseItem(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    docCount: row.docCount,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toDocItem(row: KnowledgeDocRow): KnowledgeDoc {
  return {
    id: row.id,
    kbId: row.kbId,
    name: row.name,
    source: row.source,
    chars: row.chars,
    chunks: row.chunks,
    createdAt: row.createdAt
  }
}

async function requireBase(
  db: Db,
  id: string,
  userId: string
): Promise<{ ok: true; base: KnowledgeBaseRow } | { ok: false; status: number; error: string }> {
  // 知识库是用户数据：缺少 userId 时不放行（不能靠「知道 id」绕过归属校验）
  if (!userId.trim()) return { ok: false, status: 400, error: 'userId 必填' }
  const base = await db.getKnowledgeBase(id)
  if (!base) return { ok: false, status: 404, error: '知识库不存在' }
  if (base.userId !== userId) return { ok: false, status: 403, error: '无权访问该知识库' }
  return { ok: true, base }
}

/** 粗略的二进制判定：NUL 字符或大量不可打印控制字符 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096)
  if (sample.includes('\u0000')) return true
  let control = 0
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0
    if (code < 9 || (code > 13 && code < 32)) control += 1
  }
  return control > sample.length * 0.05
}

/** HTML → 纯文本：去掉脚本/样式，块级标签转换行，解码常见实体 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
