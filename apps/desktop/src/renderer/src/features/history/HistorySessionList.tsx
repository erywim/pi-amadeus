import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { DAY_GROUP_ORDER, dayGroupOf, type Session } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' })

function timeLabel(ts: number): string {
  return dayGroupOf(ts) === 'today' ? timeFormatter.format(ts) : dateFormatter.format(ts)
}

function SessionRow({ session }: { session: Session }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const selectSession = useSessionStore((s) => s.selectSession)
  const messageCount = useSessionStore(
    (s) => session.messageCount ?? s.messages[session.id]?.length ?? 0
  )

  return (
    <button
      type="button"
      onClick={() => {
        selectSession(session.id)
        navigate('/chat')
      }}
      className="flex w-full items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-card"
    >
      <span className="min-w-0 flex-1 truncate text-sm">{session.title || t('chat.newSession')}</span>
      <Badge
        variant="outline"
        className={cn(
          'shrink-0 border px-1.5 py-0 text-[10px]',
          session.channel === 'feishu' ? 'border-feishu-blue/50 text-feishu-blue' : 'border-cyber-cyan/50 text-cyber-cyan'
        )}
      >
        {t(`channels.${session.channel}`)}
      </Badge>
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{messageCount}</span>
      <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {timeLabel(session.updatedAt)}
      </span>
    </button>
  )
}

/** 会话列表：按天分组，点击跳转聊天页并选中 */
export function HistorySessionList({ sessions }: { sessions: Session[] }): React.JSX.Element {
  const { t } = useTranslation()

  const groups = DAY_GROUP_ORDER.map((group) => ({
    group,
    sessions: sessions
      .filter((s) => dayGroupOf(s.updatedAt) === group)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })).filter((g) => g.sessions.length > 0)

  if (groups.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">{t('history.empty')}</p>
  }

  return (
    <div className="space-y-6">
      {groups.map(({ group, sessions: groupSessions }) => (
        <section key={group}>
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            {t(`dayGroups.${group}`)}
          </h2>
          <div className="space-y-0.5">
            {groupSessions.map((session) => (
              <SessionRow key={session.id} session={session} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
