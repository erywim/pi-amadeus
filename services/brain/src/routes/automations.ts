import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import type {
  AutomationItem,
  AutomationSchedule,
  AutomationTrigger
} from '@pi-amadeus/shared'
import type { AutomationRow, Db } from '../db.ts'
import {
  computeNextRun,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  type ScheduleSpec
} from '../automation/schedule.ts'
import { automationScheduler } from '../automation/scheduler.ts'
import { toPublicMessage } from '../media.ts'

const SCHEDULES = new Set<AutomationSchedule>(['interval', 'daily', 'once'])
const TRIGGERS = new Set<AutomationTrigger>(['schedule', 'file', 'webhook'])

/** 自动化任务：CRUD + 立即运行 + Webhook/文件触发 + 运行记录 */
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
    const parsed = parseCreate(body)
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)
    const value = parsed.value
    const nextRunAt =
      value.enabled && value.trigger === 'schedule' ? computeNextRun(value.spec) : null
    if (value.enabled && value.trigger === 'schedule' && nextRunAt === null) {
      return c.json({ error: '一次性任务的时间必须晚于当前时间' }, 400)
    }
    const row = await db.createAutomation({
      userId: value.userId,
      name: value.name,
      prompt: value.prompt,
      trigger: value.trigger,
      watchPath: value.watchPath,
      debounceSeconds: value.debounceSeconds,
      webhookSecret: value.webhookSecret,
      schedule: value.spec.schedule,
      intervalMinutes: value.spec.intervalMinutes,
      timeOfDay: value.spec.timeOfDay,
      runAt: value.spec.runAt,
      enabled: value.enabled,
      nextRunAt
    })
    await automationScheduler.syncWatchers()
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
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400)
      patch.enabled = body.enabled
    }

    const trigger = typeof body.trigger === 'string' ? body.trigger : row.trigger
    if (!TRIGGERS.has(trigger as AutomationTrigger)) {
      return c.json({ error: 'trigger 必须是 schedule/file/webhook' }, 400)
    }
    patch.trigger = trigger as AutomationTrigger

    const scheduleTouched =
      body.schedule !== undefined ||
      body.intervalMinutes !== undefined ||
      body.timeOfDay !== undefined ||
      body.runAt !== undefined ||
      trigger !== row.trigger
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

    // 合并后的字段用于 trigger 校验
    const next = { ...row, ...patch }
    if (next.trigger === 'file') {
      const watchPath = typeof body.watchPath === 'string' ? body.watchPath : row.watchPath
      const pathError = validateWatchPath(watchPath)
      if (pathError) return c.json({ error: pathError }, 400)
      patch.watchPath = resolve(watchPath.trim())
      const debounce = Number(body.debounceSeconds ?? row.debounceSeconds)
      if (!Number.isFinite(debounce) || debounce < 1 || debounce > 300) {
        return c.json({ error: '防抖秒数必须在 1~300 之间' }, 400)
      }
      patch.debounceSeconds = Math.floor(debounce)
      patch.nextRunAt = null
    } else if (next.trigger === 'webhook') {
      const secret =
        typeof body.webhookSecret === 'string' && body.webhookSecret.trim()
          ? body.webhookSecret.trim()
          : row.webhookSecret || newSecret()
      patch.webhookSecret = secret
      patch.nextRunAt = null
    } else {
      const spec: ScheduleSpec = {
        schedule: next.schedule,
        intervalMinutes: next.intervalMinutes,
        timeOfDay: next.timeOfDay,
        runAt: next.runAt
      }
      if (next.enabled) {
        const nextRunAt = computeNextRun(spec)
        if (nextRunAt === null && spec.schedule === 'once') {
          return c.json({ error: '一次性任务的时间必须晚于当前时间' }, 400)
        }
        patch.nextRunAt = nextRunAt
      } else {
        patch.nextRunAt = null
      }
      if (!scheduleTouched && body.enabled === undefined) {
        // 只改名称/指令：保留原计划
        delete patch.nextRunAt
      }
    }

    const updated = await db.updateAutomation(row.id, patch)
    await automationScheduler.syncWatchers()
    return c.json({ ok: true, automation: toItem(updated!) })
  })

  app.delete('/automations/:id', async (c) => {
    const row = await db.getAutomation(c.req.param('id'))
    if (!row) return c.json({ error: '自动化任务不存在' }, 404)
    await db.deleteAutomation(row.id)
    await automationScheduler.syncWatchers()
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

  /** Webhook 触发：外部系统 POST 到这里，密钥放 x-amadeus-secret */
  app.post('/automations/:id/trigger', async (c) => {
    const row = await db.getAutomation(c.req.param('id'))
    if (!row) return c.json({ error: '自动化任务不存在' }, 404)
    if (row.trigger !== 'webhook') return c.json({ error: '该任务不是 Webhook 触发' }, 400)
    if (row.webhookSecret) {
      const secret = c.req.header('x-amadeus-secret') ?? ''
      if (secret !== row.webhookSecret) return c.json({ error: '密钥不匹配' }, 401)
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const text =
      typeof body?.text === 'string'
        ? body.text
        : body
          ? JSON.stringify(body)
          : ''
    const started = await automationScheduler.triggerWebhook(row.id, text.slice(0, 2000))
    if (!started) return c.json({ error: '任务正在运行中' }, 409)
    return c.json({ ok: true }, 202)
  })

  /** 该任务的会话消息（运行记录；成功回合的回复已落库） */
  app.get('/automations/:id/messages', async (c) => {
    const row = await db.getAutomation(c.req.param('id'))
    if (!row) return c.json({ error: '自动化任务不存在' }, 404)
    const messages = await db.listMessages(`automation-${row.id}`)
    return c.json({ messages: messages.map(toPublicMessage) })
  })

  return app
}

function toItem(row: AutomationRow): AutomationItem {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    trigger: row.trigger,
    watchPath: row.watchPath,
    debounceSeconds: row.debounceSeconds,
    webhookSecret: row.webhookSecret,
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
    lastTrigger: row.lastTrigger,
    sessionId: `automation-${row.id}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function newSecret(): string {
  return randomBytes(16).toString('hex')
}

function validateWatchPath(raw: string): string | null {
  const value = raw.trim()
  if (!value) return '请填写要监听的文件或目录路径'
  const resolved = resolve(value)
  if (!existsSync(resolved)) return `路径不存在：${resolved}`
  try {
    const stat = statSync(resolved)
    if (!stat.isFile() && !stat.isDirectory()) return '路径必须是文件或目录'
  } catch {
    return '路径无法访问'
  }
  return null
}

type ParsedCreate =
  | {
      value: {
        userId: string
        name: string
        prompt: string
        trigger: AutomationTrigger
        watchPath: string
        debounceSeconds: number
        webhookSecret: string
        spec: ScheduleSpec
        enabled: boolean
      }
    }
  | { error: string }

function parseCreate(body: Record<string, unknown> | null): ParsedCreate {
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  if (!userId) return { error: 'userId 必填' }
  if (!name) return { error: '名称必填' }
  if (name.length > 80) return { error: '名称最多 80 字' }
  if (!prompt) return { error: '指令必填' }
  if (prompt.length > 4000) return { error: '指令最多 4000 字' }

  const trigger = typeof body?.trigger === 'string' ? body.trigger : 'schedule'
  if (!TRIGGERS.has(trigger as AutomationTrigger)) {
    return { error: 'trigger 必须是 schedule/file/webhook' }
  }

  const schedule = typeof body?.schedule === 'string' ? body.schedule : 'daily'
  if (!SCHEDULES.has(schedule as AutomationSchedule)) {
    return { error: 'schedule 必须是 interval/daily/once' }
  }
  const intervalRaw = Number(body?.intervalMinutes ?? 60)
  const intervalMinutes = Number.isFinite(intervalRaw) ? Math.floor(intervalRaw) : 60
  if (
    schedule === 'interval' &&
    (intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > MAX_INTERVAL_MINUTES)
  ) {
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
    if (runAt <= Date.now()) return { error: '一次性任务的时间必须晚于当前时间' }
  }

  let watchPath = ''
  let debounceSeconds = 2
  let webhookSecret = ''
  if (trigger === 'file') {
    const rawPath = typeof body?.watchPath === 'string' ? body.watchPath : ''
    const pathError = validateWatchPath(rawPath)
    if (pathError) return { error: pathError }
    watchPath = resolve(rawPath.trim())
    const debounce = Number(body?.debounceSeconds ?? 2)
    if (!Number.isFinite(debounce) || debounce < 1 || debounce > 300) {
      return { error: '防抖秒数必须在 1~300 之间' }
    }
    debounceSeconds = Math.floor(debounce)
  } else if (trigger === 'webhook') {
    webhookSecret =
      typeof body?.webhookSecret === 'string' && body.webhookSecret.trim()
        ? body.webhookSecret.trim()
        : newSecret()
  }

  return {
    value: {
      userId,
      name,
      prompt,
      trigger: trigger as AutomationTrigger,
      watchPath,
      debounceSeconds,
      webhookSecret,
      spec: { schedule: schedule as AutomationSchedule, intervalMinutes, timeOfDay, runAt },
      enabled: body?.enabled !== false
    }
  }
}
