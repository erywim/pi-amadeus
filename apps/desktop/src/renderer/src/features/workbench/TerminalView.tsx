import * as React from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolActivityItem } from '@pi-amadeus/shared'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { summarizeArgs, summarizeResult } from './helpers'

interface TerminalEntry {
  id: string
  item: ToolActivityItem
}

/**
 * 暗色终端（Lancer 的 Terminal 面板）：
 * 只显示当前会话真实发生过的工具调用——历史回合从 workLogs 取，
 * 流式中的从 stream 取，停止的回合从 stoppedLogs 取。没有调用就是空提示。
 */
export function TerminalView(): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) =>
    s.activeSessionId ? (s.messages[s.activeSessionId] ?? []) : []
  )
  const workLogs = useSessionStore((s) => s.workLogs)
  const stream = useSessionStore((s) => s.stream)
  const stoppedLog = useSessionStore((s) =>
    s.activeSessionId ? s.stoppedLogs[s.activeSessionId] : undefined
  )

  const entries: TerminalEntry[] = []
  const seen = new Set<string>()
  const push = (item: ToolActivityItem): void => {
    if (seen.has(item.toolCallId)) return
    seen.add(item.toolCallId)
    entries.push({ id: item.toolCallId, item })
  }
  for (const message of messages) {
    for (const item of workLogs[message.id]?.tools ?? []) push(item)
  }
  if (stream.streaming && stream.sessionId === activeSessionId) {
    for (const item of stream.tools) push(item)
  }
  for (const item of stoppedLog?.tools ?? []) push(item)

  const sessionLabel = activeSessionId ? activeSessionId.slice(0, 8) : '—'

  return (
    <div
      data-testid="terminal-panel"
      className="flex h-full min-h-0 flex-col bg-[#0d1117] text-[#c9d1d9]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 font-mono text-[10.5px] text-white/45">
        <span className="text-[#7ee787]">$</span>
        <span className="truncate">
          amadeus · {t('workbench.terminal.session')} {sessionLabel}
        </span>
        <span className="ml-auto shrink-0">{entries.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.65]">
        {entries.length === 0 ? (
          <p data-testid="terminal-empty" className="text-white/35">
            <span className="text-[#7ee787]">❯</span> {t('workbench.terminal.idle')}
            <span className="lancer-caret" />
          </p>
        ) : (
          <div className="space-y-2.5">
            {entries.map((entry) => (
              <div key={entry.id} data-testid="terminal-entry" data-tool={entry.item.toolName}>
                <div className="flex items-center gap-1.5">
                  <span className="text-[#7ee787]">❯</span>
                  <span className="text-[#79c0ff]">{entry.item.toolName}</span>
                  <StatusIcon status={entry.item.status} />
                </div>
                <p className="break-words pl-3.5 text-[#7ee787]">
                  {summarizeArgs(entry.item.args) || '{}'}
                </p>
                {entry.item.summary && (
                  <pre className="mt-0.5 whitespace-pre-wrap break-words pl-3.5 text-[10.5px] leading-[1.55] text-[#8b949e]">
                    {summarizeResult(entry.item.summary)}
                  </pre>
                )}
                {entry.item.status === 'error' && (
                  <p className="pl-3.5 text-[10.5px] text-[#ff7b72]">
                    {t('workbench.terminal.error')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-1.5 font-mono text-[9.5px] text-white/35">
        <span className={cn('size-1.5 rounded-full', stream.streaming ? 'bg-[#7ee787]' : 'bg-white/25')} />
        {stream.streaming ? t('workbench.terminal.running') : t('workbench.terminal.success')}
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: ToolActivityItem['status'] }): React.JSX.Element {
  if (status === 'running') {
    return <Loader2 className="size-3 animate-spin text-[#d29922]" />
  }
  if (status === 'success') {
    return <Check className="size-3 text-[#7ee787]" strokeWidth={2.4} />
  }
  return <X className="size-3 text-[#ff7b72]" strokeWidth={2.4} />
}
