import * as React from 'react'
import { PanelLeft, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 文本模式的标题栏：侧栏开关 + 标题 + 渠道徽标 + 轮次统计 + 删除 */
export function CodexTitlebar({
  sidebarOpen,
  onToggleSidebar
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const messageCount = useSessionStore((s) => {
    const loaded = s.activeSessionId ? s.messages[s.activeSessionId] : undefined
    return loaded?.length ?? s.sessions.find((x) => x.id === s.activeSessionId)?.messageCount ?? 0
  })
  const deleteSession = useSessionStore((s) => s.deleteSession)

  if (!session) {
    return <div className="h-[52px] shrink-0 border-b border-border" />
  }

  const turns = Math.ceil(messageCount / 2)

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
      <button
        type="button"
        aria-label={t('codex.sidebarToggle')}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
        className="grid size-9.5 place-items-center rounded-[10px] border border-border bg-surface text-ink-2 transition-colors hover:bg-surface-soft"
      >
        <PanelLeft className="size-4" strokeWidth={1.8} />
      </button>
      <h2 className="min-w-0 truncate text-[15px] font-semibold">
        {session.title || t('codex.untitledTask')}
      </h2>
      <Badge
        variant="outline"
        className={cn(
          'gap-1.5 border',
          session.channel === 'feishu'
            ? 'border-feishu-blue/50 text-feishu-blue'
            : 'border-border text-muted-foreground'
        )}
      >
        {t(`channels.${session.channel}`)}
      </Badge>
      <span className="flex-1" />
      <span className="whitespace-nowrap text-[12.5px] text-muted-foreground">
        {t('codex.turns', { count: turns })}
      </span>
      <button
        type="button"
        title={t('chat.deleteTitle')}
        onClick={() => {
          deleteSession(session.id)
          toast.success(t('common.deleted'))
        }}
        className="grid size-9.5 place-items-center rounded-[10px] border border-border bg-surface text-ink-2 transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-4" strokeWidth={1.6} />
      </button>
    </header>
  )
}
