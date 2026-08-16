import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** 时间/日期：零网络零密钥，提供准确报时（LLM 无法可靠知道当前时间） */

export const timeToolSchema = Type.Object({}, { additionalProperties: false })

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

export function createTimeTool(): AgentTool<typeof timeToolSchema> {
  return {
    name: 'get_time',
    label: '查询时间',
    description: '获取当前日期与时间（本地时区）。用户询问"现在几点/今天几号/星期几"等时效性问题时使用。',
    parameters: timeToolSchema,
    execute: async () => {
      const now = new Date()
      const iso = now.toISOString()
      const offsetMinutes = -now.getTimezoneOffset()
      const offset = `${offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`
      const text =
        `当前时间：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
        `星期${WEEKDAYS[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')} ` +
        `（本地时区 UTC${offset}）`
      return {
        content: [{ type: 'text', text }],
        details: { iso, unix: Math.floor(now.getTime() / 1000), timezoneOffset: offset }
      }
    }
  }
}
