import type { AutomationSchedule } from '@pi-amadeus/shared'

/** 自动化任务的下一次触发时间（纯函数，路由与调度器共用同一套语义） */

export const MIN_INTERVAL_MINUTES = 5
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60

export interface ScheduleSpec {
  schedule: AutomationSchedule
  intervalMinutes: number
  /** HH:MM（本地时区），仅 daily 使用 */
  timeOfDay: string
  /** 绝对时间戳，仅 once 使用 */
  runAt: number | null
}

/** 计算 from 之后的下一次触发时间；once 已过期返回 null（由调用方决定是否停用） */
export function computeNextRun(spec: ScheduleSpec, from = Date.now()): number | null {
  if (spec.schedule === 'interval') {
    const minutes = Math.min(
      MAX_INTERVAL_MINUTES,
      Math.max(MIN_INTERVAL_MINUTES, Math.floor(spec.intervalMinutes))
    )
    return from + minutes * 60_000
  }
  if (spec.schedule === 'daily') {
    return nextDaily(from, spec.timeOfDay)
  }
  if (spec.runAt === null) return null
  return spec.runAt > from ? spec.runAt : null
}

/** 下一个本地 HH:MM（今天已过就明天） */
export function nextDaily(from: number, timeOfDay: string): number {
  const [hourRaw, minuteRaw] = timeOfDay.split(':')
  const hour = Math.min(23, Math.max(0, Number(hourRaw) || 0))
  const minute = Math.min(59, Math.max(0, Number(minuteRaw) || 0))
  const date = new Date(from)
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0)
  if (target.getTime() <= from) target.setDate(target.getDate() + 1)
  return target.getTime()
}

/** 人类可读的调度描述（服务端日志/错误信息用；界面自己按语言渲染） */
export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.schedule === 'interval') return `每 ${spec.intervalMinutes} 分钟`
  if (spec.schedule === 'daily') return `每天 ${spec.timeOfDay}`
  return spec.runAt ? `一次性 ${new Date(spec.runAt).toLocaleString()}` : '一次性'
}
