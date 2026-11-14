import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import type { Db } from '../db.ts'

/** 消息附件读取：id 是服务端生成的 UUID，文件在数据目录内 */
export function mediaRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/media/:id', async (c) => {
    const row = await db.getMedia(c.req.param('id'))
    if (!row) return c.json({ error: '附件不存在' }, 404)
    try {
      const buffer = await readFile(row.path)
      const encodedName = encodeURIComponent(row.name)
      return c.body(new Uint8Array(buffer), 200, {
        'Content-Type': row.mimeType,
        'Content-Length': String(buffer.length),
        'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, max-age=31536000, immutable'
      })
    } catch (error) {
      console.warn(
        `[media] 附件文件丢失 ${row.id}:`,
        error instanceof Error ? error.message : error
      )
      return c.json({ error: '附件文件丢失' }, 404)
    }
  })

  return app
}
