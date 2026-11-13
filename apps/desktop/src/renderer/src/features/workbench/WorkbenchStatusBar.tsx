import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { activeProviderOf, useProviderStore } from '@renderer/stores/providerStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore } from '@renderer/stores/uiStore'

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})

/** 底部状态条（Lancer 的 workspace status bar）：全部数字来自真实会话与回合 */
export function WorkbenchStatusBar(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const stream = useSessionStore((s) => s.stream)
  const username = useUiStore((s) => s.username)
  const providers = useProviderStore((s) => s.providers)
  const fallbackModel = useSettingsStore((s) => s.aiConfig.provider.model)
  const model = activeProviderOf(providers)?.model || fallbackModel
  const [now, setNow] = useState(() => Date.now())

  // 时间只用于显示，不需要逐秒刷新；30 秒一次足够
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const turns = sessions.reduce(
    (sum, session) => sum + Math.ceil((session.messageCount ?? 0) / 2),
    0
  )
  const streaming = stream.streaming

  return (
    <footer
      data-testid="workbench-status"
      className="flex h-[30px] items-center gap-3 border-t border-border bg-surface px-4 text-[10.5px] text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-foreground text-[8.5px] font-semibold text-background">
          {(username ?? 'A').charAt(0).toUpperCase()}
        </span>
        <span className="max-w-[110px] truncate font-medium text-ink-2">
          {username ?? t('workbench.status.workspace')}
        </span>
        <span className="hidden sm:inline">· {t('workbench.status.workspace')}</span>
      </span>

      <span className="hidden items-center gap-2 md:flex">
        <span>{t('workbench.status.sessions', { count: sessions.length })}</span>
        <span>·</span>
        <span>{t('workbench.status.turns', { count: turns })}</span>
        {activeSessionId && (
          <>
            <span>·</span>
            <span className="font-mono text-[9.5px] text-muted-foreground/70">
              {activeSessionId.slice(0, 8)}
            </span>
          </>
        )}
      </span>

      <span className="flex-1" />

      <span
        data-testid="status-streaming"
        data-streaming={streaming ? 'true' : 'false'}
        className="inline-flex items-center gap-1.5"
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            streaming ? 'anim-blink bg-mint' : 'bg-line-strong'
          )}
        />
        {streaming ? t('workbench.status.streaming') : t('workbench.status.idle')}
      </span>
      <span className="hidden max-w-[160px] truncate font-mono text-[9.5px] text-muted-foreground/80 sm:inline">
        {model || t('workbench.status.model')}
      </span>
      <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground/80">
        {timeFormatter.format(now)}
      </span>
    </footer>
  )
}
