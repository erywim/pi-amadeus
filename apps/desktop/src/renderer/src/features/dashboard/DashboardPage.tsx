import * as React from 'react'
import { useEffect, useState } from 'react'
import { BarChart3, RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { StatsResponse } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { fetchStats } from '@renderer/lib/api'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { AreaChart, BarChart, DonutChart, HBarList } from './charts'

const numberFormat = new Intl.NumberFormat()

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function shortDay(day: string): string {
  const [, month, date] = day.split('-')
  return `${Number(month)}/${Number(date)}`
}

/** 数据看板：会话/消息/回合/工具/Token + 近 14 天趋势 + 渠道、模型、工具、插件分布 */
export default function DashboardPage(): React.JSX.Element {
  const { t } = useTranslation()
  const userId = useSessionStore((s) => s.userId)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async (): Promise<void> => {
    if (!userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setStats(await fetchStats(userId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // 只在登录身份变化时重拉；刷新按钮走 load
  }, [userId])

  if (!userId) {
    return (
      <div className="grid h-full place-items-center">
        <p className="text-[13px] text-muted-foreground">{t('dashboard.loginRequired')}</p>
      </div>
    )
  }

  const totals = stats?.totals
  const series = stats?.series ?? []
  const activity = series.map((point) => ({ label: shortDay(point.day), value: point.turns }))
  const tokenSeries = series.map((point) => ({ label: shortDay(point.day), value: point.tokens }))
  const channels = (stats?.channels ?? []).map((item) => ({
    label: t(`channels.${item.channel}`),
    value: item.count
  }))
  const tools = (stats?.tools ?? []).map((item) => ({ label: item.name, value: item.count }))
  const models = (stats?.models ?? []).map((item) => ({
    label: item.model,
    value: item.tokens
  }))
  const providerUsage = (stats?.providers ?? []).map((item) => ({
    label: item.name,
    value: item.turns
  }))
  const pluginKinds = stats
    ? [
        { label: t('plugins.kind.skill'), value: stats.plugins.byKind.skill },
        { label: t('plugins.kind.prompt'), value: stats.plugins.byKind.prompt },
        { label: t('plugins.kind.theme'), value: stats.plugins.byKind.theme },
        { label: t('plugins.kind.mcp'), value: stats.plugins.byKind.mcp }
      ].filter((item) => item.value > 0)
    : []

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
              <BarChart3 className="size-5 text-primary" strokeWidth={1.8} />
              {t('dashboard.title')}
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">{t('dashboard.subtitle')}</p>
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('dashboard.refresh')}
          </Button>
        </div>

        {!stats ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">
            {loading ? t('dashboard.loading') : t('dashboard.empty')}
          </p>
        ) : (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile testId="sessions" label={t('dashboard.kpi.sessions')} value={numberFormat.format(totals!.sessions)} />
              <StatTile testId="messages" label={t('dashboard.kpi.messages')} value={numberFormat.format(totals!.messages)} />
              <StatTile testId="turns" label={t('dashboard.kpi.turns')} value={numberFormat.format(totals!.turns)} />
              <StatTile testId="toolCalls" label={t('dashboard.kpi.toolCalls')} value={numberFormat.format(totals!.toolCalls)} />
              <StatTile
                testId="tokens"
                label={t('dashboard.kpi.tokens')}
                value={formatTokens(totals!.totalTokens)}
                hint={t('dashboard.kpi.tokensHint', {
                  input: formatTokens(totals!.inputTokens),
                  output: formatTokens(totals!.outputTokens)
                })}
              />
              <StatTile
                testId="memories"
                label={t('dashboard.kpi.memories')}
                value={numberFormat.format(stats.memories)}
              />
              <StatTile
                testId="affinity"
                label={t('dashboard.kpi.affinity')}
                value={numberFormat.format(stats.affinity.score)}
                hint={t(`memory.stage.${stats.affinity.stageKey}`)}
              />
              <StatTile
                testId="plugins"
                label={t('dashboard.kpi.plugins')}
                value={numberFormat.format(stats.plugins.total)}
                hint={t('dashboard.kpi.pluginsHint', { enabled: stats.plugins.enabled })}
              />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card title={t('dashboard.chart.activity')} hint={t('dashboard.chart.activityHint')}>
                <BarChart data={activity} />
              </Card>
              <Card title={t('dashboard.chart.tokens')} hint={t('dashboard.chart.tokensHint')}>
                <AreaChart data={tokenSeries} />
              </Card>
              <Card title={t('dashboard.chart.channels')}>
                <DonutChart data={channels} />
              </Card>
              <Card title={t('dashboard.chart.tools')}>
                <HBarList items={tools} emptyText={t('dashboard.chart.noTools')} />
              </Card>
              <Card title={t('dashboard.chart.models')}>
                <HBarList items={models} emptyText={t('dashboard.chart.noModels')} />
              </Card>
              <Card title={t('dashboard.chart.plugins')}>
                <HBarList items={pluginKinds} emptyText={t('dashboard.chart.noPlugins')} />
              </Card>
              <Card title={t('dashboard.chart.providers')}>
                <HBarList items={providerUsage} emptyText={t('dashboard.chart.noProviders')} />
              </Card>
            </div>

            <p className="mt-6 text-[11.5px] leading-relaxed text-muted-foreground">
              {t('dashboard.footnote')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function StatTile({
  testId,
  label,
  value,
  hint
}: {
  testId: string
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div data-testid={`kpi-${testId}`} className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-[24px] font-semibold leading-tight tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Card({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-testid="dashboard-card" className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  )
}
