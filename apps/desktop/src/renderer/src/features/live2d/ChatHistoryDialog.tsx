import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/** 聊天记录弹窗：会话列表，点击跳转聊天页并选中 */
export function ChatHistoryDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const open = useUiStore((s) => s.chatHistoryOpen)
  const setChatHistoryOpen = useUiStore((s) => s.setChatHistoryOpen)
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <Dialog open={open} onOpenChange={setChatHistoryOpen}>
      <DialogContent className="max-h-[70vh] max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-[0.2em] text-primary">
            {t('live2d.chatHistory.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-0.5 overflow-y-auto">
          {sorted.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                selectSession(session.id)
                setChatHistoryOpen(false)
                navigate('/text')
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{session.title || t('chat.newSession')}</span>
              <Badge
                variant="outline"
                className={cn(
                  'shrink-0 border px-1.5 py-0 text-[10px]',
                  session.channel === 'feishu'
                    ? 'border-feishu-blue/50 text-feishu-blue'
                    : 'border-cyber-cyan/50 text-cyber-cyan'
                )}
              >
                {t(`channels.${session.channel}`)}
              </Badge>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
