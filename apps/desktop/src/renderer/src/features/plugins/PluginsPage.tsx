import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Blocks, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogEntry, PluginKind } from '@pi-amadeus/shared'
import { PLUGIN_KINDS } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import { usePluginStore } from '@renderer/stores/pluginStore'
import { AddMcpDialog } from './AddMcpDialog'
import { entryOf } from './entry'
import { PluginCard } from './PluginCard'
import { PluginDetailDialog } from './PluginDetailDialog'

type Tab = 'discover' | 'installed'
type KindFilter = PluginKind | 'all'

/**
 * 插件中心：发现 / 已安装两页 + kind 过滤 + 搜索。
 * 目录是内置的（离线可用），安装动作由大脑执行；MCP 插件安装后立即尝试连接。
 */
export default function PluginsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const installed = usePluginStore((s) => s.installed)
  const catalog = usePluginStore((s) => s.catalog)
  const loaded = usePluginStore((s) => s.loaded)
  const load = usePluginStore((s) => s.load)
  const activeThemeId = usePluginStore((s) => s.activeThemeId)
  const [tab, setTab] = useState<Tab>('discover')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [addMcpOpen, setAddMcpOpen] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const installedById = useMemo(
    () => new Map(installed.map((plugin) => [plugin.id, plugin])),
    [installed]
  )

  const matches = (entry: CatalogEntry): boolean => {
    if (kind !== 'all' && entry.kind !== kind) return false
    const keyword = query.trim().toLowerCase()
    if (!keyword) return true
    return [entry.name, entry.description, entry.category, ...entry.tags]
      .join(' ')
      .toLowerCase()
      .includes(keyword)
  }

  const discoverList = catalog.filter(matches)
  const installedList = installed
    .map((plugin) => ({ plugin, entry: entryOf(plugin, catalog) }))
    .filter(({ entry }) => matches(entry))
    .sort((a, b) => PLUGIN_KINDS.indexOf(a.plugin.kind) - PLUGIN_KINDS.indexOf(b.plugin.kind))

  const detailEntry = detailId ? (catalog.find((entry) => entry.id === detailId) ?? null) : null
  const detailInstalled = detailId ? installedById.get(detailId) : undefined

  // 自定义 MCP 不在目录里：详情弹窗用补出来的条目
  const customEntry: CatalogEntry | null =
    detailId && !detailEntry && detailInstalled ? entryOf(detailInstalled, catalog) : null
  const resolvedEntry = detailEntry ?? customEntry

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
              <Blocks className="size-5 text-primary" strokeWidth={1.8} />
              {t('plugins.title')}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              {t('plugins.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 focus-within:border-primary">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                data-testid="plugin-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('plugins.search')}
                aria-label={t('plugins.search')}
                className="h-auto w-44 border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => setAddMcpOpen(true)}>
              <Plus className="size-3.5" />
              {t('plugins.mcp.add')}
            </Button>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="flex gap-0.5 rounded-xl border border-border bg-surface-soft p-[3px]">
            {(['discover', 'installed'] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-testid="plugins-tab"
                data-tab={value}
                onClick={() => setTab(value)}
                className={cn(
                  'rounded-[9px] px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-ink-2',
                  tab === value && 'bg-surface font-semibold text-foreground shadow-[0_1px_3px_rgba(26,29,33,0.10)]'
                )}
              >
                {t(`plugins.tab.${value}`)}
                {value === 'installed' && installed.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                    {installed.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <KindChip value="all" current={kind} label={t('plugins.kind.all')} onSelect={setKind} />
            {PLUGIN_KINDS.map((value) => (
              <KindChip
                key={value}
                value={value}
                current={kind}
                label={t(`plugins.kind.${value}`)}
                onSelect={setKind}
              />
            ))}
          </div>
        </div>

        {!loaded ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">{t('plugins.loading')}</p>
        ) : tab === 'discover' ? (
          discoverList.length === 0 ? (
            <EmptyState text={t('plugins.emptySearch')} />
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {discoverList.map((entry) => (
                <PluginCard
                  key={entry.id}
                  entry={entry}
                  installed={installedById.get(entry.id)}
                  activeTheme={activeThemeId === entry.id}
                  onOpen={() => setDetailId(entry.id)}
                />
              ))}
            </div>
          )
        ) : installedList.length === 0 ? (
          <EmptyState text={t('plugins.emptyInstalled')} />
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {installedList.map(({ entry, plugin }) => (
              <PluginCard
                key={plugin.id}
                entry={entry}
                installed={plugin}
                activeTheme={activeThemeId === plugin.id}
                onOpen={() => setDetailId(plugin.id)}
              />
            ))}
          </div>
        )}

        <p className="mt-8 border-t border-border pt-4 text-[11.5px] leading-relaxed text-muted-foreground">
          {t('plugins.securityNote')}
        </p>
      </div>

      <PluginDetailDialog
        entry={resolvedEntry}
        installed={detailInstalled}
        activeTheme={detailId !== null && activeThemeId === detailId}
        onClose={() => setDetailId(null)}
      />
      <AddMcpDialog open={addMcpOpen} onClose={() => setAddMcpOpen(false)} />
    </div>
  )
}

function KindChip({
  value,
  current,
  label,
  onSelect
}: {
  value: KindFilter
  current: KindFilter
  label: string
  onSelect: (value: KindFilter) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="plugin-kind-chip"
      data-kind={value}
      onClick={() => onSelect(value)}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
        current === value
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:bg-surface-soft hover:text-ink-2'
      )}
    >
      {label}
    </button>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="mt-4 grid place-items-center rounded-xl border border-dashed border-border py-16">
      <p className="text-[13px] text-muted-foreground">{text}</p>
    </div>
  )
}
