import { Hono } from 'hono'
import type { AutomationItem, AutomationSchedule } from '@pi-amadeus/shared'
import type { AutomationRow, Db } from '../db.ts'
import {
  computeNextRun,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  type ScheduleSpec
} from '../automation/schedule.ts'
import { automationScheduler } from '../automation/scheduler.ts'

const SCHEDULES = new Set<AutomationSchedule>(['interval', 'daily', 'once'])

/** 自动化任务：CRUD + 立即运行 + 运行记录（会话消息） */
export function automationRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/automations', async (c) => {
    const userId = c.req.query('userId') ?? ''
    if (!userId) return c.json({ error: 'userId 必填' }, 400)
    const rows = await db.listAutomations(userId)
    return c.json({ automations: rows.map(toItem) })
  })

  app.post('/automations', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const parsed = parseInput(body, true)
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)
    const { userId, name, prompt, spec, enabled } = parsed.value
    const nextRunAt = enabled ? computeNextRun(spec) : null
    if (enabled && nextRunAt === null) {
      return c.json({ error: '一次性任务的时间必须晚于当前时间' }, 400)
    }
    const row = await db.createAutomation({
      userId,
      name,
      prompt,
      schedule: spec.schedule,
      intervalMinutes: spec.intervalMinutes,
      timeOfDay: spec.timeOfDay,
      runAt: spec.runAt,
      enabled,
      nextRunAt
    })
    return c.json({ ok: true, automation: toItem(row) })
  })

  app.patch('/automations/:id', async (c) => {
    const row = await db.getAutomation(c.req.param('id'))
    if (!row) return c.json({ error: '自动化任务不存在' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: '请求体必须是 JSON' }, 400)

    const patch: Parameters<Db['updateAutomation']>[1] = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name) return c.json({ error: '名称不能为空' }, 400)
      if (name.length > 80) return c.json({ error: '名称最多 80 字' }, 400)
      patch.name = name
    }
    if (typeof body.prompt === 'string') {
      const prompt = body.prompt.trim()
      if (!prompt) return c.json({ error: '指令不能为空' }, 400)
      if (prompt.length > 4000) return c.json({ error: '指令最多 4000 字' }, 400)
      patch.prompt = prompt
    }

    const scheduleChanged =
      body.schedule !== undefined ||
      body.intervalMinutes !== undefined ||
      body.timeOfDay !== undefined ||
      body.runAt !== undefined
    if (body.schedule !== undefined) {
      if (typeof body.schedule !== 'string' || !SCHEDULES.has(body.schedule as AutomationSchedule)) {
        return c.json({ error: 'schedule 必须是 interval/daily/once' }, 400)
      }
      patch.schedule = body.schedule as AutomationSchedule
    }
    if (body.intervalMinutes !== undefined) {
      const minutes = Number(body.intervalMinutes)
      if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        return c.json({ error: `间隔必须在 ${MIN_INTERVAL_MINUTES}~${MAX_INTERVAL_MINUTES} 分钟之间` }, 400)
      }
      patch.intervalMinutes = Math.floor(minutes)
    }
    if (body.timeOfDay !== undefined) {
      if (typeof body.timeOfDay !== 'string' || !/^\d{2}:\d{2}$/.test(body.timeOfDay)) {
        return c.json({ error: 'timeOfDay 必须是 HH:MM' }, 400)
      }
      patch.timeOfDay = body.timeOfDay
    }
    if (body.runAt !== undefined) {
      if (body.runAt === null) patch.runAt = null
      else {
        const runAt = Number(body.runAt)
        if (!Number.isFinite(runAt)) return c.json({ error: 'runAt 必须是时间戳' }, 400)
        patch.runAt = Math.floor(runAt)
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400)
      patch.enabled = body.enabled
    }

    // 调度字段或启停变化后重算下次触发；只是改名/改指令则保留原计划
    const nextRows = { ...row, ...patch }
    const spec: ScheduleSpec = {
      schedule: nextRows.schedule,
      intervalMinutes: nextRows.intervalMinutes,
      timeOfDay: nextRows.timeOfDay,
      runAt: nextRows.runAt
    }
    if (patch.enabled === false) {
      patch.nextRunAt = null
    } else if (patch.enabled === true || (scheduleChanged && nextRows.enabled)) {
      const next = computeNextRun(spec)
      if (next === null && spec.schedule === 'once') {
        return c.json({ error: '一次性任务的时间必须晚于当前时间' }, 400)
      }
      patch.nextRunAt = next
    }

    const updated = await db.updateAutomation(row.id, patch)
    return c.json({ ok: true, automation: toItem(updated!) })
  })

  app.delete('/automations/:id', async (c) => {
    const row = await db.getAutomation(c.req.param('id'))
    if (!row) return c.json({ error: '自动化任务不存在' }, 404)
    await db.deleteAutomation(row.id)
    return c.json({ ok: true })
  })

  /** 立即运行：异步执行，界面轮询 lastStatus/lastRunAt */
  app.post('/automations/:id/run', async (c) => {
    const row = await db.getAutomation(c.req.param('id'))
    if (!row) return c.json({ error: '自动化任务不存在' }, 404)
    if (row.lastStatus === 'running') return c.json({ error: '任务正在运行中' }, 409)
    const started = await automationScheduler.runNow(row.id)
    if (!started) return c.json({ error: '任务启动失败（可能正在运行）' }, 409)
    return c.json({ ok: true }, 202)
  })

  /** 该任务的会话消息（运行记录；成功回合的回复已落库） */
  app.get('/automations/:id/messages', async (c) => {
    const row = await db.getAutomation(c.req.param('id'))
    if (!row) return c.json({ error: '自动化任务不存在' }, 404)
    const messages = await db.listMessages(`automation-${row.id}`)
    return c.json({ messages })
  })

  return app
}

function toItem(row: AutomationRow): AutomationItem {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    intervalMinutes: row.intervalMinutes,
    timeOfDay: row.timeOfDay,
    runAt: row.runAt,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastResult: row.lastResult,
    sessionId: `automation-${row.id}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

type ParsedInput =
  | {
      value: {
        userId: string
        name: string
        prompt: string
        spec: ScheduleSpec
        enabled: boolean
      }
    }
  | { error: string }

function parseInput(body: Record<string, unknown> | null, creating: boolean): ParsedInput {
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  if (!userId) return { error: 'userId 必填' }
  if (!name) return { error: '名称必填' }
  if (name.length > 80) return { error: '名称最多 80 字' }
  if (!prompt) return { error: '指令必填' }
  if (prompt.length > 4000) return { error: '指令最多 4000 字' }
  const schedule = typeof body?.schedule === 'string' ? body.schedule : ''
  if (!SCHEDULES.has(schedule as AutomationSchedule)) {
    return { error: 'schedule 必须是 interval/daily/once' }
  }
  const intervalRaw = Number(body?.intervalMinutes ?? 60)
  const intervalMinutes = Number.isFinite(intervalRaw) ? Math.floor(intervalRaw) : 60
  if (schedule === 'interval' && (intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > MAX_INTERVAL_MINUTES)) {
    return { error: `间隔必须在 ${MIN_INTERVAL_MINUTES}~${MAX_INTERVAL_MINUTES} 分钟之间` }
  }
  const timeOfDay = typeof body?.timeOfDay === 'string' ? body.timeOfDay : '09:00'
  if (schedule === 'daily' && !/^\d{2}:\d{2}$/.test(timeOfDay)) {
    return { error: 'timeOfDay 必须是 HH:MM' }
  }
  let runAt: number | null = null
  if (schedule === 'once') {
    const value = Number(body?.runAt)
    if (!Number.isFinite(value)) return { error: '一次性任务需要 runAt 时间戳' }
    runAt = Math.floor(value)
    if (creating && runAt <= Date.now()) return { error: '一次性任务的时间必须晚于当前时间' }
  }
  const enabled = body?.enabled !== false
  return {
    value: {
      userId,
      name,
      prompt,
      spec: { schedule: schedule as AutomationSchedule, intervalMinutes, timeOfDay, runAt },
      enabled
    }
  }
}
