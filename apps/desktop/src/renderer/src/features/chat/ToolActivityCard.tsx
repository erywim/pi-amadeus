import * as React from 'react'
import { useEffect, useState } from 'react'
import { Check, ChevronDown, Clock, Loader2, ShieldAlert, Terminal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PendingToolConfirm, ToolActivityItem } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'

/** 工具名显示：i18n chat.toolName.<name>，未翻译时兜底原始名 */
function toolDisplayName(t: (key: string) => string, name: string): string {
  const key = `chat.toolName.${name}`
  const translated = t(key)
  return translated === key ? name : translated
}

interface StatusIconProps {
  status: ToolActivityItem['status']
}

function StatusIcon({ status }: StatusIconProps): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-cyber-cyan" />
    case 'success':
      return <Check className="size-3.5 shrink-0 text-terminal-green" />
    case 'blocked':
      return <ShieldAlert className="size-3.5 shrink-0 text-amber-sg" />
    case 'denied':
      return <X className="size-3.5 shrink-0 text-amber-sg" />
    case 'timeout':
      return <Clock className="size-3.5 shrink-0 text-amber-sg" />
    case 'error':
      return <X className="size-3.5 shrink-0 text-destructive" />
  }
}

function statusKey(status: ToolActivityItem['status']): string {
  return `chat.toolStatus.${status}`
}

function commandOf(item: ToolActivityItem): string | null {
  if (item.toolName !== 'bash') return null
  const command = item.args.command
  return typeof command === 'string' ? command : null
}

interface ToolActivityCardProps {
  item: ToolActivityItem
}

/** 流式气泡下方的一行工具活动：状态图标 + 工具名 + 摘要（可折叠） */
export function ToolActivityCard({ item }: ToolActivityCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const command = commandOf(item)
  const hasSummary = !!item.summary

  return (
    <div className="ml-11 max-w-[75%]">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground">
        <StatusIcon status={item.status} />
        <span className="shrink-0">{toolDisplayName(t, item.toolName)}</span>
        {command && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/70">
            $ {command}
          </span>
        )}
        <span className="shrink-0">{t(statusKey(item.status))}</span>
        {hasSummary && (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            title={expanded ? t('chat.toolCollapse') : t('chat.toolExpand')}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {expanded && item.summary && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
          {item.summary}
        </pre>
      )}
    </div>
  )
}

interface BashConfirmCardProps {
  confirm: PendingToolConfirm
  onRespond: (approved: boolean) => void
}

/** bash 确认卡：命令 + 倒计时 + 允许/拒绝（服务端超时自动拒绝） */
export function BashConfirmCard({ confirm, onRespond }: BashConfirmCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [remainingMs, setRemainingMs] = useState(() => confirm.expiresAt - Date.now())

  useEffect(() => {
    const timer = setInterval(() => setRemainingMs(confirm.expiresAt - Date.now()), 250)
    return () => clearInterval(timer)
  }, [confirm.expiresAt])

  const command = typeof confirm.args.command === 'string' ? confirm.args.command : ''
  const expired = remainingMs <= 0
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))

  return (
    <div className="ml-11 max-w-[75%]">
      <div className="rounded-md border border-amber-sg/50 bg-amber-sg/10 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-sg">
          <Terminal className="size-3.5" />
          <span>{t('chat.toolConfirmTitle')}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('chat.toolConfirmDesc')}</p>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-card px-2.5 py-2 font-mono text-[11px] leading-relaxed">
          {command}
        </pre>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" disabled={expired} onClick={() => onRespond(true)}>
            {t('chat.toolApprove')}
          </Button>
          <Button size="sm" variant="outline" disabled={expired} onClick={() => onRespond(false)}>
            {t('chat.toolReject')}
          </Button>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {expired ? t('chat.toolConfirmExpired') : t('chat.toolConfirmExpires', { seconds })}
          </span>
        </div>
      </div>
    </div>
  )
}
