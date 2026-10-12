import { Hono } from 'hono'
import { pushFrame } from '../conversation.ts'

/**
 * 单帧解码后字节数上限。桌面端帧为 640px 宽、质量 0.6 的 JPEG
 * （apps/desktop camera.ts，实测约 30~100KB），上限取 4MB（≥30 倍余量），
 * 挡住灌水帧，同时不拒分辨率/画质上调后的合法帧。
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** 严格 base64 字符集/填充形态（配合"长度为 4 的倍数"构成完整校验；用扁平字符类，避免长串上嵌套量词回溯溢出） */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** N 字节二进制对应的 base64 最大长度（含填充余量） */
const MAX_FRAME_BASE64_LENGTH = Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 4

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
    // 先按编码长度挡超大帧（避免无谓解码），再做严格形态校验与解码后长度检查（防止存进垃圾/被灌水）
    if (frame.length > MAX_FRAME_BASE64_LENGTH) {
      return c.json({ error: 'frame 超出大小上限' }, 400)
    }
    if (!STRICT_BASE64_RE.test(frame) || frame.length % 4 !== 0) {
      return c.json({ error: 'frame 不是合法 base64' }, 400)
    }
    if (Buffer.from(frame, 'base64').length > MAX_FRAME_BYTES) {
      return c.json({ error: 'frame 超出大小上限' }, 400)
    }
    pushFrame(userId, frame)
    return c.json({ ok: true })
  })

  return app
}
