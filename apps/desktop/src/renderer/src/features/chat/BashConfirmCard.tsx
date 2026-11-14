import * as React from 'react'
import { useEffect, useState } from 'react'
import { Monitor, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PendingToolConfirm } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'

/** 本机工具确认卡：命令/Computer Use 参数 + 倒计时 + 允许/拒绝。 */
export function BashConfirmCard({
  confirm,
  onRespond
}: {
  confirm: PendingToolConfirm
  onRespond: (approved: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [remainingMs, setRemainingMs] = useState(() => confirm.expiresAt - Date.now())

  useEffect(() => {
    const timer = setInterval(() => setRemainingMs(confirm.expiresAt - Date.now()), 250)
    return () => clearInterval(timer)
  }, [confirm.expiresAt])

  const command =
    confirm.kind === 'bash'
      ? typeof confirm.args.command === 'string'
        ? confirm.args.command
        : ''
      : JSON.stringify(confirm.args, null, 2) || '{}'
  const displayArgs = command.length > 4000 ? `${command.slice(0, 4000)}…` : command
  const expired = remainingMs <= 0
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const title = confirm.kind === 'computer' ? t('chat.computerConfirmTitle') : t('chat.toolConfirmTitle')
  const description =
    confirm.kind === 'computer' ? t('chat.computerConfirmDesc') : t('chat.toolConfirmDesc')

  return (
    <div className="w-full">
      <div className="rounded-[10px] border border-amber-sg/50 bg-amber-sg/10 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-sg">
          {confirm.kind === 'computer' ? <Monitor className="size-3.5" /> : <Terminal className="size-3.5" />}
          <span>{confirm.label || title}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-card px-2.5 py-2 font-mono text-[11px] leading-relaxed">
          {displayArgs}
        </pre>
        <div className="mt-2 flex items-center gap-2">
          <Button
            data-testid="bash-confirm-approve"
            size="sm"
            disabled={expired}
            onClick={() => onRespond(true)}
          >
            {t('chat.toolApprove')}
          </Button>
          <Button
            data-testid="bash-confirm-reject"
            size="sm"
            variant="outline"
            disabled={expired}
            onClick={() => onRespond(false)}
          >
            {t('chat.toolReject')}
          </Button>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {expired
              ? t('chat.toolConfirmExpired')
              : t('chat.toolConfirmExpires', { seconds })}
          </span>
        </div>
      </div>
    </div>
  )
}
