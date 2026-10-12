import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { DAY_GROUP_ORDER, dayGroupOf, type Session } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { useDivergenceStore } from '@renderer/stores/divergenceStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/** 会话状态点：当前流式进行中 → 琥珀脉冲；已完成 → 薄荷绿 */
function SessionStatusDot({ running }: { running: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-[7px] flex-none rounded-full',
        running ? 'anim-blink bg-primary' : 'bg-mint'
      )}
    />
  )
}

function SessionItem({
  session,
  active,
  running,
  onSelect,
  onDelete
}: {
  session: Session
  active: boolean
  running: boolean
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const turns = Math.ceil((session.messageCount ?? 0) / 2)

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group w-full cursor-pointer rounded-[10px] px-3 py-2.5 text-ink-2 transition-colors',
        active ? 'bg-surface shadow-[inset_0_0_0_1px_var(--border)]' : 'hover:bg-surface-soft'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SessionStatusDot running={running && active} />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-medium">
          {session.title || t('codex.untitledTask')}
        </span>
        <Badge
          variant="outline"
          className={cn(
            'shrink-0 border px-1.5 py-0 text-[10px]',
            session.channel === 'feishu'
              ? 'border-feishu-blue/50 text-feishu-blue'
              : 'border-border text-muted-foreground'
          )}
        >
          {t(`channels.${session.channel}`)}
        </Badge>
        <button
          type="button"
          title={t('chat.deleteTitle')}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:inline-flex"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="overflow-hidden text-ellipsis whitespace-nowrap pl-[15px] text-[12.5px] text-muted-foreground">
        {t('codex.agentSub', {
          status: running && active ? t('codex.stateRunning') : t('codex.stateDone'),
          turns
        })}
      </div>
    </div>
  )
}

/**
 * Codex 风会话侧栏：新任务按钮 / 按天分组的会话列表（状态点 + 轮次副标题） /
 * 底部用户卡（头像、名、研究所头衔、当前世界线读数）。
 */
export function SessionSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSession = useSessionStore((s) => s.createSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const streaming = useSessionStore((s) => s.stream.streaming)
  const username = useUiStore((s) => s.username)
  const worldLine = useDivergenceStore((s) => s.value)

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
    <aside className="grid w-[268px] shrink-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] border-r border-border bg-background">
      <div className="px-4 pb-2 pt-4">
        <button
          type="button"
          onClick={() => createSession()}
          className="flex w-full items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 py-[9px] text-[15px] font-semibold text-foreground transition-colors hover:bg-surface-soft"
        >
          <Plus className="size-4 text-muted-foreground" strokeWidth={2} />
          {t('codex.newTask')}
        </button>
      </div>
      <div className="px-4 pb-1 pt-3 text-[12.5px] tracking-[0.04em] text-muted-foreground">
        {t('codex.sessionsLabel')}
      </div>
      <div className="flex min-h-0 flex-col gap-px overflow-y-auto px-2 py-1">
        {groups.map(({ group, sessions: groupSessions }) => (
          <section key={group} className="mb-2">
            <h3 className="mb-1 px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              {t(`dayGroups.${group}`)}
            </h3>
            <div className="space-y-0.5">
              {groupSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  running={streaming}
                  onSelect={() => selectSession(session.id)}
                  onDelete={() => handleDelete(session.id)}
                />
              ))}
            </div>
          </section>
        ))}
        {sessions.length === 0 && (
          <p className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            {t('chat.empty')}
          </p>
        )}
      </div>
      {/* 底部：用户卡 + 世界线彩蛋读数 */}
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span className="grid size-7 flex-none place-items-center rounded-full bg-foreground text-[12.5px] font-semibold text-background">
          {(username ?? t('codex.defaultUser')).charAt(0).toUpperCase()}
        </span>
        <span className="grid min-w-0">
          <b className="truncate text-[13.5px] font-semibold">{username ?? t('codex.defaultUser')}</b>
          <span className="text-[12.5px] text-muted-foreground">{t('codex.userRole')}</span>
          <span className="text-[10.5px] text-muted-foreground">
            {t('codex.currentWorldLine')}{' '}
            <span className="font-digit text-[11px] tracking-[0.05em] text-ink-2">{worldLine}</span>
          </span>
        </span>
      </div>
    </aside>
  )
}
