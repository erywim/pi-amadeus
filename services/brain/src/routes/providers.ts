import { Hono } from 'hono'
import type { ProviderInput } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'
import {
  activateProvider,
  createProviderItem,
  deleteProviderItem,
  listProviderItems,
  testProvider,
  updateProviderItem
} from '../providers/registry.ts'

/** 多模型服务：列表 / 新增 / 编辑 / 删除 / 激活 / 连通性测试 */
export function providerRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/providers', async (c) => {
    return c.json({ providers: await listProviderItems(db) })
  })

  app.post('/providers', async (c) => {
    const input = await readInput(c)
    if (!input) return c.json({ error: '请求体不合法' }, 400)
    const result = await createProviderItem(db, input)
    if (!result.ok) return c.json({ error: result.error }, 400)
    return c.json({ ok: true, provider: result.provider })
  })

  app.patch('/providers/:id', async (c) => {
    const input = await readInput(c)
    if (!input) return c.json({ error: '请求体不合法' }, 400)
    const result = await updateProviderItem(db, c.req.param('id'), input)
    if (!result.ok) return c.json({ error: result.error }, result.notFound ? 404 : 400)
    return c.json({ ok: true, provider: result.provider })
  })

  app.delete('/providers/:id', async (c) => {
    const removed = await deleteProviderItem(db, c.req.param('id'))
    if (!removed) return c.json({ error: '模型服务不存在' }, 404)
    return c.json({ ok: true })
  })

  app.put('/providers/:id/active', async (c) => {
    const result = await activateProvider(db, c.req.param('id'))
    if (!result.ok) return c.json({ error: result.error }, result.notFound ? 404 : 400)
    return c.json({ ok: true, provider: result.provider })
  })

  app.post('/providers/:id/test', async (c) => {
    return c.json(await testProvider(db, c.req.param('id')))
  })

  return app
}

async function readInput(c: { req: { json: () => Promise<unknown> } }): Promise<ProviderInput | null> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return null
  const str = (key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : '')
  return {
    name: str('name'),
    baseUrl: str('baseUrl'),
    model: str('model'),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    proxy: typeof body.proxy === 'string' ? body.proxy : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    priority: typeof body.priority === 'number' ? body.priority : undefined
  }
}
