import { Hono } from 'hono'
import { resolveBashConfirm } from '../tools/confirm.ts'

/** bash 命令确认回执：POST /api/tool-confirm { turnId, toolCallId, approved }。
 * 无鉴权——与本地 API 同一信任模型（turnId 为每回合随机 UUID）。 */
export function toolConfirmRoutes(): Hono {
  const app = new Hono()

  app.post('/tool-confirm', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { turnId?: unknown; toolCallId?: unknown; approved?: unknown }
      | null
    const turnId = typeof body?.turnId === 'string' ? body.turnId : ''
    const toolCallId = typeof body?.toolCallId === 'string' ? body.toolCallId : ''
    const approved = body?.approved === true
    if (!turnId || !toolCallId) {
      return c.json({ error: 'turnId/toolCallId 必填' }, 400)
    }
    const result = resolveBashConfirm(turnId, toolCallId, approved)
    if (!result.ok) {
      return c.json({ error: '确认请求不存在或已超时' }, 404)
    }
    return c.json({ status: result.status })
  })

  return app
}
