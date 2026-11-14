import * as React from 'react'
import { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ComputerRequest } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'

/** Computer Use 确认卡：输入动作每次确认，截图请求也明确告知会发送屏幕内容。 */
export function ComputerConfirmCard({ request, onRespond }: { request: ComputerRequest; onRespond: (approved: boolean) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [remainingMs, setRemainingMs] = useState(() => request.expiresAt - Date.now())
  useEffect(() => {
    const timer = setInterval(() => setRemainingMs(request.expiresAt - Date.now()), 250)
    return () => clearInterval(timer)
  }, [request.expiresAt])
  const expired = remainingMs <= 0
  const detail = request.action === 'type' ? String(request.args.text ?? '').slice(0, 140) : JSON.stringify(request.args)
  return (
    <div className="w-full rounded-[10px] border border-violet-400/50 bg-violet-400/10 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-300"><Monitor className="size-3.5" /><span>{t('chat.computerConfirmTitle')}</span></div>
      <p className="mt-1 text-xs text-muted-foreground">{t('chat.computerConfirmDesc')}</p>
      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-card px-2.5 py-2 font-mono text-[11px]">{detail}</pre>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={expired} onClick={() => onRespond(true)}>{t('chat.toolApprove')}</Button>
        <Button size="sm" variant="outline" disabled={expired} onClick={() => onRespond(false)}>{t('chat.toolReject')}</Button>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{expired ? t('chat.toolConfirmExpired') : `${Math.max(0, Math.ceil(remainingMs / 1000))}s`}</span>
      </div>
    </div>
  )
}
