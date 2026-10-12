import * as React from 'react'
import { useEffect, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolActivityItem } from '@pi-amadeus/shared'
import { cn } from '@renderer/lib/utils'
import type { TurnWorkLog } from '@renderer/stores/sessionStore'

/** 工具名显示：i18n chat.toolName.<name>，未翻译时兜底原始名 */
function toolDisplayName(t: (key: string) => string, name: string): string {
  const key = `chat.toolName.${name}`
  const translated = t(key)
  return translated === key ? name : translated
}

function toolDetailOf(item: ToolActivityItem): string {
  const command = item.toolName === 'bash' && typeof item.args.command === 'string' ? item.args.command : null
  const raw = command ?? item.summary ?? ''
  // 单行摘要：第一行 + 截断
  return raw.split('\n')[0]!.slice(0, 140)
}

function formatDuration(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`
}

interface WorkProcessCardProps {
  /** 进行中的回合：实时工具列表直接传（sessionStore.stream.tools） */
  live?: { tools: ToolActivityItem[]; startedAtMs?: never }
  /** 已完成/已停止回合：归档快照 */
  log?: TurnWorkLog
}

/**
 * Codex 风工作过程折叠卡：处理中（转环）→ 已处理 / 已停止（✓ + 耗时），
 * 展开可见逐行工具调用（工具名 + 摘要首行）。
 */
export function WorkProcessCard({ live, log }: WorkProcessCardProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const tools = live?.tools ?? log?.tools ?? []
  const running = live !== undefined
  const stopped = !running && (log?.stopped ?? false)

  const [open, setOpen] = useState(running)
  // 回合开始自动展开方便围观，结束后自动收起（用户手动开合以最后一次为准）
  useEffect(() => {
    setOpen(running)
  }, [running])

  if (tools.length === 0) return null

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] text-ink-2"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        {running ? (
          <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-primary" />
        ) : (
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-mint text-white">
            <Check className="size-2.5" strokeWidth={3} />
          </span>
        )}
        <span>{running ? t('codex.workWorking') : stopped ? t('codex.workStopped') : t('codex.workDone')}</span>
        {!running && log && (
          <span className="ml-auto font-mono text-[12.5px] text-muted-foreground">
            {stopped ? t('codex.workStoppedByUser') : formatDuration(log.durationMs)}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 border-t border-border px-3 py-2">
          {tools.map((item) => {
            const detail = toolDetailOf(item)
            return (
              <div
                key={item.toolCallId}
                className="flex items-baseline gap-2 font-mono text-[12.5px] text-muted-foreground"
              >
                <b className="shrink-0 font-semibold text-ink-2">{toolDisplayName(t, item.toolName)}</b>
                {detail && <span className="min-w-0 flex-1 truncate">{detail}</span>}
                <span className="shrink-0">{t(`chat.toolStatus.${item.status}`)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
