import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { DAY_GROUP_ORDER, dayGroupOf, type Session } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'

function SessionItem({
  session,
  active,
  onSelect,
  onDelete
}: {
  session: Session
  active: boolean
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors',
        active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{session.title || t('chat.newSession')}</span>
      <Badge
        variant="outline"
        className={cn(
          'shrink-0 border px-1.5 py-0 text-[10px]',
          session.channel === 'feishu' ? 'border-feishu-blue/50 text-feishu-blue' : 'border-cyber-cyan/50 text-cyber-cyan'
        )}
      >
        {t(`channels.${session.channel}`)}
      </Badge>
      <Button
        variant="ghost"
        size="icon"
        title={t('chat.deleteTitle')}
        className="hidden size-6 shrink-0 text-muted-foreground hover:bg-destructive/15 hover:text-destructive group-hover:inline-flex [&_svg]:size-3.5"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        <Trash2 />
      </Button>
    </div>
  )
}

/** 280px 会话侧栏：按天分组（今天/昨天/本周/更早），hover 显示删除 */
export function SessionSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSession = useSessionStore((s) => s.createSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)

  const groups = DAY_GROUP_ORDER.map((group) => ({
    group,
    sessions: sessions
      .filter((s) => dayGroupOf(s.updatedAt) === group)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })).filter((g) => g.sessions.length > 0)

  function handleDelete(id: string): void {
    deleteSession(id)
    toast.success(t('common.deleted'))
  }

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-semibold">{t('nav.sessions')}</span>
        <Button variant="ghost" size="icon" className="size-8" title={t('chat.newSession')} onClick={createSession}>
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map(({ group, sessions: groupSessions }) => (
          <section key={group} className="mb-3">
            <h3 className="mb-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              {t(`dayGroups.${group}`)}
            </h3>
            <div className="space-y-0.5">
              {groupSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  onSelect={() => selectSession(session.id)}
                  onDelete={() => handleDelete(session.id)}
                />
              ))}
            </div>
          </section>
        ))}
        {sessions.length === 0 && (
          <p className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">{t('chat.empty')}</p>
        )}
      </div>
    </aside>
  )
}
