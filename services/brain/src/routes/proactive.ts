import { Hono } from 'hono'
import type { ProactiveInput, ProactiveResponse } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'
import { generateProactiveGreeting, proactiveScheduler } from '../proactive/index.ts'

/** 主动问候：设置 / 最新一条 / 立即生成 */
export function proactiveRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/proactive', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const [settings, latest, todayCount] = await Promise.all([
      db.getProactiveSettings(userId),
      db.latestProactiveGreeting(userId),
      countToday(db, userId)
    ])
    const response: ProactiveResponse = { settings, latest, todayCount }
    return c.json(response)
  })

  app.put('/proactive', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | (ProactiveInput & { userId?: unknown })
      | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const patch: Parameters<Db['updateProactiveSettings']>[1] = {}
    if (body?.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400)
      patch.enabled = body.enabled
    }
    if (body?.minIdleMinutes !== undefined) {
      const value = Number(body.minIdleMinutes)
      if (!Number.isFinite(value) || value < 5 || value > 10_080) {
        return c.json({ error: '空闲分钟数必须在 5~10080 之间' }, 400)
      }
      patch.minIdleMinutes = Math.floor(value)
    }
    if (body?.activeStart !== undefined) {
      if (typeof body.activeStart !== 'string' || !/^\d{2}:\d{2}$/.test(body.activeStart)) {
        return c.json({ error: 'activeStart 必须是 HH:MM' }, 400)
      }
      patch.activeStart = body.activeStart
    }
    if (body?.activeEnd !== undefined) {
      if (typeof body.activeEnd !== 'string' || !/^\d{2}:\d{2}$/.test(body.activeEnd)) {
        return c.json({ error: 'activeEnd 必须是 HH:MM' }, 400)
      }
      patch.activeEnd = body.activeEnd
    }
    if (body?.maxPerDay !== undefined) {
      const value = Number(body.maxPerDay)
      if (!Number.isFinite(value) || value < 1 || value > 20) {
        return c.json({ error: '每天次数必须在 1~20 之间' }, 400)
      }
      patch.maxPerDay = Math.floor(value)
    }
    const settings = await db.updateProactiveSettings(userId, patch)
    return c.json({ ok: true, settings })
  })

  /** 立即生成一条（不等空闲窗口；用于预览与 E2E） */
  app.post('/proactive/run', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { userId?: unknown } | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const greeting = await proactiveScheduler.runNow(userId)
    if (!greeting) {
      return c.json({ error: '生成失败：检查模型配置，或稍后再试' }, 502)
    }
    return c.json({ ok: true, greeting })
  })

  return app
}

async function countToday(db: Db, userId: string): Promise<number> {
  const date = new Date()
  const since = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return db.countProactiveToday(userId, since)
}

// 供 index.ts 直接启动调度器时复用
export { generateProactiveGreeting }
