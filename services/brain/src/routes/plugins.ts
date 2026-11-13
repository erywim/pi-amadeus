import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import {
  addCustomMcp,
  installPlugin,
  listPluginCenter,
  reconnectPlugin,
  setPluginEnabled,
  uninstallPlugin
} from '../plugins/registry.ts'

/**
 * 插件中心：目录 + 已安装 + 安装/卸载/启停 + 自定义 MCP。
 * 安装是显式的用户动作——MCP 插件会启动本机进程，接口不做自动安装。
 */
export function pluginRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  app.get('/plugins', async (c) => {
    return c.json(await listPluginCenter(cfg, db))
  })

  app.post('/plugins/:id/install', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as
      | { fields?: Record<string, unknown> }
      | null
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(body?.fields ?? {})) {
      if (typeof value === 'string') fields[key] = value
    }
    const result = await installPlugin(cfg, db, id, fields)
    if (!result.ok) {
      const status =
        result.code === 'notFound' ? 404 : result.code === 'conflict' ? 409 : result.code === 'io' ? 500 : 400
      return c.json({ error: result.message }, status as 400)
    }
    return c.json({ ok: true, plugin: result.plugin })
  })

  app.delete('/plugins/:id', async (c) => {
    const result = await uninstallPlugin(cfg, db, c.req.param('id'))
    if (!result.ok) {
      const status = result.code === 'notFound' ? 404 : 500
      return c.json({ error: result.message }, status as 404)
    }
    return c.json({ ok: true })
  })

  app.put('/plugins/:id/enabled', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
    const result = await setPluginEnabled(db, c.req.param('id'), body?.enabled === true)
    if (!result.ok) return c.json({ error: result.message }, 404)
    return c.json({ ok: true, plugin: result.plugin })
  })

  app.post('/plugins/:id/reconnect', async (c) => {
    const result = await reconnectPlugin(db, c.req.param('id'))
    if (!result.ok) {
      const status = result.code === 'notFound' ? 404 : result.code === 'badRequest' ? 400 : 500
      return c.json({ error: result.message }, status as 400)
    }
    return c.json({ ok: true, plugin: result.plugin })
  })

  // 高级入口：目录之外的 MCP 服务（命令 + 参数 + 环境变量）
  app.post('/mcp/custom', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { name?: unknown; command?: unknown; args?: unknown; env?: unknown }
      | null
    const args = Array.isArray(body?.args)
      ? body.args.filter((arg): arg is string => typeof arg === 'string')
      : []
    const env: Record<string, string> = {}
    if (body?.env && typeof body.env === 'object' && !Array.isArray(body.env)) {
      for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) env[key] = value
      }
    }
    const result = await addCustomMcp(db, {
      name: typeof body?.name === 'string' ? body.name : '',
      command: typeof body?.command === 'string' ? body.command : '',
      args,
      env
    })
    if (!result.ok) return c.json({ error: result.message }, 400)
    return c.json({ ok: true, plugin: result.plugin })
  })

  return app
}
