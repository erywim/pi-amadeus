import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorldlineSummary } from '@pi-amadeus/shared'
import { fetchWorldlines } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'

/**
 * 世界线指示器：标题栏上的「世界线 n/m · 变动率」。
 * 点开是跳转面板——每条世界线一个条目（序号、变动率、末句预览），
 * 点一下就跳过去（世界线跳跃）。
 */
export function WorldlineBadge(): React.JSX.Element | null {
  const { t } = useTranslation()
  const sessionId = useSessionStore((s) => s.activeSessionId)
  const worldline = useSessionStore((s) => (s.activeSessionId ? s.worldlines[s.activeSessionId] : undefined))
  const jumpToWorldline = useSessionStore((s) => s.jumpToWorldline)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<WorldlineSummary[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点面板外面关闭（与常见弹出层一致）
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // 打开时拉一次世界线列表；切换会话后重新拉
  useEffect(() => {
    if (!open || !sessionId) return
    let cancelled = false
    setItems(null)
    fetchWorldlines(sessionId)
      .then((list) => {
        if (!cancelled) setItems(list)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  // 空会话没有世界线可展示
  if (!worldline || worldline.total === 0) return null

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-testid="worldline-badge"
        onClick={() => setOpen((v) => !v)}
        title={t('worldline.badgeHint')}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11.5px] transition-colors',
          worldline.rewound
            ? 'border-primary/50 bg-accent-soft text-primary'
            : 'border-border bg-surface text-ink-2 hover:bg-surface-soft'
        )}
      >
        <GitBranch className="size-3" strokeWidth={2} />
        <span>
          {t('worldline.badge', { index: worldline.index, total: worldline.total })}
        </span>
        <span className="text-muted-foreground">{worldline.divergence.toFixed(6)}%</span>
        {worldline.rewound && <span className="text-primary">· {t('worldline.rewound')}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[340px] overflow-hidden rounded-[10px] border border-border bg-surface shadow-[var(--shadow-pop)]">
          <div className="border-b border-border px-3 py-2 text-[12px] font-medium text-ink-2">
            {t('worldline.panelTitle')}
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {items === null && (
              <p className="px-3 py-3 text-[12px] text-muted-foreground">{t('worldline.loading')}</p>
            )}
            {items?.length === 0 && (
              <p className="px-3 py-3 text-[12px] text-muted-foreground">{t('worldline.empty')}</p>
            )}
            {items?.map((item) => (
              <button
                key={item.leafId}
                type="button"
                data-testid={`worldline-item-${item.index}`}
                onClick={() => {
                  jumpToWorldline(item.leafId)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-surface-soft',
                  item.active && 'bg-accent-soft'
                )}
              >
                <span className="w-6 shrink-0 font-mono text-muted-foreground">#{item.index}</span>
                <span className="w-[68px] shrink-0 font-mono text-[11.5px] text-primary">
                  {item.divergence.toFixed(6)}%
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {item.preview || t('worldline.emptyLine')}
                </span>
                {item.active && <span className="shrink-0 text-[11px] text-primary">{t('worldline.current')}</span>}
              </button>
            ))}
          </div>
          <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {t('worldline.readingSteiner')}
          </p>
        </div>
      )}
    </div>
  )
}
