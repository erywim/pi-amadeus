import * as React from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogEntry, InstalledPlugin } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'

/** MCP 连接状态点：连接中脉动、失败红、已连接绿 */
export function McpStateBadge({ plugin }: { plugin: InstalledPlugin }): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = plugin.status
  if (!status) return null
  if (status.state === 'connected') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-mint">
        <Check className="size-3" strokeWidth={2.5} />
        {t('plugins.mcp.connected', { count: status.tools.length })}
      </span>
    )
  }
  if (status.state === 'connecting') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        {t('plugins.mcp.connecting')}
      </span>
    )
  }
  if (status.state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
        <CircleAlert className="size-3" />
        {t('plugins.mcp.failed')}
      </span>
    )
  }
  return <span className="text-[11px] text-muted-foreground">{t('plugins.mcp.disabled')}</span>
}

export function PluginCard({
  entry,
  installed,
  activeTheme = false,
  onOpen
}: {
  entry: CatalogEntry
  installed?: InstalledPlugin
  activeTheme?: boolean
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const accent = entry.accent ?? 'var(--primary)'

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="plugin-card"
      data-plugin-id={entry.id}
      data-plugin-kind={entry.kind}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="group flex min-h-[148px] cursor-pointer flex-col rounded-xl border border-border bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[var(--shadow-pop)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-3">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-[10px] text-[20px]"
          style={{
            background: `linear-gradient(135deg, ${accent}26, ${accent}0a)`,
            border: `1px solid ${accent}33`
          }}
        >
          {entry.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <b className="truncate text-[14px] font-semibold">{entry.name}</b>
            {installed && (
              <Badge variant="outline" className="shrink-0 border-mint/40 px-1.5 py-0 text-[10px] text-mint">
                {t('plugins.installedBadge')}
              </Badge>
            )}
            {activeTheme && (
              <Badge variant="outline" className="shrink-0 border-primary/40 px-1.5 py-0 text-[10px] text-primary">
                {t('plugins.activeTheme')}
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
            {entry.description}
          </p>
        </div>
      </div>

      <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-3">
        <Badge variant="outline" className="shrink-0 border-border px-1.5 py-0 text-[10px] text-muted-foreground">
          {t(`plugins.kind.${entry.kind}`)}
        </Badge>
        {entry.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="truncate text-[11px] text-muted-foreground/80">
            #{tag}
          </span>
        ))}
        <span className="flex-1" />
        {installed?.kind === 'mcp' && <McpStateBadge plugin={installed} />}
        {!installed && <span className="shrink-0 text-[11px] text-muted-foreground">{entry.author}</span>}
      </div>
    </div>
  )
}
