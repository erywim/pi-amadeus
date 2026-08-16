import * as React from 'react'
import { Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 当前会话头部：标题 + 渠道徽标 + 在线状态 + 删除 */
export function ChatHeader(): React.JSX.Element {
  const { t } = useTranslation()
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const deleteSession = useSessionStore((s) => s.deleteSession)

  if (!session) {
    return <div className="h-14 shrink-0 border-b border-border" />
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{session.title || t('chat.newSession')}</h2>
      <Badge
        variant="outline"
        className={cn(
          'gap-1.5 border',
          session.channel === 'feishu' ? 'border-feishu-blue/50 text-feishu-blue' : 'border-cyber-cyan/50 text-cyber-cyan'
        )}
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            session.channel === 'feishu' ? 'bg-feishu-blue' : 'bg-cyber-cyan'
          )}
        />
        {t(`channels.${session.channel}`)}
      </Badge>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-terminal-green" />
        {t('chat.online')}
      </span>
      <Button
        variant="ghost"
        size="icon"
        title={t('chat.deleteTitle')}
        className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        onClick={() => {
          deleteSession(session.id)
          toast.success(t('common.deleted'))
        }}
      >
        <Trash2 />
      </Button>
    </header>
  )
}
