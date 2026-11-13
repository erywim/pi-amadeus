import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { checkFrame } from '../frames.ts'
import { runProactiveGreeting } from '../proactive.ts'

/**
 * 主动问候：POST /api/proactive { userId, sessionId?, frame }
 *
 * 桌面主进程在应用处于后台 / 桌宠模式时定时截屏调用。返回落库后的问候
 * （含情绪），主进程据此弹系统通知并推给渲染层。截图不落库、不回显。
 */
export function proactiveRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  app.post('/proactive', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; sessionId?: unknown; frame?: unknown }
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const frame = typeof body?.frame === 'string' ? body.frame : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (!userId || !frame) return c.json({ error: 'userId/frame 必填' }, 400)
    // 在解码/模型调用之前拒绝未知身份，避免截图被处理后才因外键失败
    if (!(await db.getUser(userId))) {
      return c.json({ error: '用户不存在', code: 'user_not_found' }, 404)
    }

    const checked = checkFrame(frame)
    if (!checked.ok) return c.json({ error: checked.error }, 400)

    const result = await runProactiveGreeting({
      cfg,
      db,
      userId,
      sessionId: sessionId || undefined,
      frame,
      signal: c.req.raw.signal
    })
    if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status)
    return c.json({ ok: true, ...result.greeting, model: result.model })
  })

  return app
}
