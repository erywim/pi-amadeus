import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 历史页统计条：会话数 / 消息数 / 活跃渠道 / 活跃天数 */
export function StatsStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const messages = useSessionStore((s) => s.messages)

  const stats = [
    { label: t('history.statsSessions'), value: sessions.length },
    { label: t('history.statsMessages'), value: Object.values(messages).reduce((n, list) => n + list.length, 0) },
    { label: t('history.statsChannels'), value: new Set(sessions.map((s) => s.channel)).size },
    { label: t('history.statsDays'), value: new Set(sessions.map((s) => new Date(s.updatedAt).toDateString())).size }
  ]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-md border border-border bg-card px-4 py-3">
          <div className="text-xs text-muted-foreground">{stat.label}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-terminal-green text-glow-green">{stat.value}</div>
        </div>
      ))}
    </div>
  )
}
