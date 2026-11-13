import * as React from 'react'
import { AlertTriangle, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * 回合失败卡：错误信息 + 重试 + 关闭。
 * 失败必须留在会话里可见——只写 console 会让用户以为助手没反应。
 */
export function TurnErrorCard({
  message,
  onRetry,
  onDismiss
}: {
  message: string
  onRetry: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      role="alert"
      data-testid="turn-error"
      className="grid grid-cols-[30px_minmax(0,1fr)] gap-3"
    >
      <div className="grid size-[30px] place-items-center rounded-full border border-destructive/40 bg-destructive/10 text-destructive">
        <AlertTriangle className="size-4" strokeWidth={2} />
      </div>
      <div className="min-w-0 rounded-[10px] border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <b className="block text-[13.5px] font-semibold text-destructive">{t('chat.turnFailed')}</b>
            <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-ink-2">{message}</p>
          </div>
          <button
            type="button"
            data-testid="dismiss-turn-error"
            onClick={onDismiss}
            title={t('chat.dismissError')}
            aria-label={t('chat.dismissError')}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            data-testid="retry-turn"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] font-medium text-foreground transition-colors hover:bg-surface-soft"
          >
            <RotateCcw className="size-3.5" strokeWidth={2} />
            {t('chat.retry')}
          </button>
        </div>
      </div>
    </div>
  )
}
