import { Hono } from 'hono'
import { pushFrame } from '../conversation.ts'

/** 视觉输入：POST /api/frames { userId, frame }（base64 JPEG，每用户保留最近 2 帧） */
export function frameRoutes(): Hono {
  const app = new Hono()

  app.post('/frames', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; frame?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const frame = typeof body?.frame === 'string' ? body.frame : ''
    if (!userId || !frame) return c.json({ error: 'userId/frame 必填' }, 400)
    // base64 解码校验（防止存进垃圾）
    try {
      Buffer.from(frame, 'base64')
    } catch {
      return c.json({ error: 'frame 不是合法 base64' }, 400)
    }
    pushFrame(userId, frame)
    return c.json({ ok: true })
  })

  return app
}
