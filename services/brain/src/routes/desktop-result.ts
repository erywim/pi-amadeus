import { Hono } from 'hono'
import type { ComputerResult } from '@pi-amadeus/shared'
import { resolveDesktopResult } from '../tools/desktop-bridge.ts'

/** Electron renderer 执行 computer 请求后的单次回执。 */
export function desktopResultRoutes(): Hono {
  const app = new Hono()

  app.post('/desktop-result', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<ComputerResult> | null
    if (
      !body ||
      typeof body.turnId !== 'string' ||
      typeof body.toolCallId !== 'string' ||
      typeof body.requestId !== 'string' ||
      typeof body.approved !== 'boolean'
    ) {
      return c.json({ error: 'turnId/toolCallId/requestId/approved 必填' }, 400)
    }
    if (body.screenshot?.data && body.screenshot.data.length > 8_000_000) {
      return c.json({ error: '截图过大' }, 413)
    }
    const result = resolveDesktopResult(body as ComputerResult)
    if (!result.ok) return c.json({ error: result.status === 'invalid' ? '回执不匹配' : '请求不存在' }, 404)
    return c.json({ ok: true })
  })

  return app
}
