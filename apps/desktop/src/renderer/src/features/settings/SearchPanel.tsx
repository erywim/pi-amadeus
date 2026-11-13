import * as React from 'react'
import { useEffect, useState } from 'react'
import { CheckCircle2, Globe, LoaderCircle, RefreshCw, Search, XCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { SearchDiagnostics, SearchEngineName, SearchTestResponse } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { fetchSearchStatus, testSearchApi } from '@renderer/lib/api'

/**
 * 联网搜索：
 * - 引擎可达性是运行时事实，全部由服务端真实探测得出（不写死「可用」）
 * - 「测试搜索」用输入的关键词真的搜一次，逐条展示命中与失败原因
 * - 引擎顺序即降级顺序：第一个有结果的引擎返回；全都不可用时如实报告
 */
export function SearchPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SearchDiagnostics | null>(null)
  const [checking, setChecking] = useState(false)
  const [query, setQuery] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SearchTestResponse | null>(null)

  async function check(): Promise<void> {
    setChecking(true)
    try {
      setStatus(await fetchSearchStatus())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
  }, [])

  async function runTest(): Promise<void> {
    const trimmed = query.trim()
    if (!trimmed) return
    setTesting(true)
    try {
      setResult(await testSearchApi(trimmed))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="max-w-xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t('settings.search.title')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('settings.search.desc')}
          </p>
        </div>
        <Button
          data-testid="search-recheck"
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => void check()}
        >
          {checking ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t('settings.search.recheck')}
        </Button>
      </div>

      <div className="mt-4 grid gap-2">
        {status === null && (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {t('settings.search.checking')}
          </p>
        )}
        {status?.engines.map((engine) => (
          <div
            key={engine.engine}
            data-testid="search-engine-row"
            data-engine={engine.engine}
            data-ok={engine.ok ? 'true' : 'false'}
            className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2.5"
          >
            {engine.ok ? (
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
            ) : (
              <XCircle className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <b className="text-[13.5px] font-semibold">{t(`settings.search.engine.${engine.engine}`)}</b>
                {engine.engine === 'tavily' && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                    {status.tavilyConfigured
                      ? t('settings.search.tavilyOn')
                      : t('settings.search.tavilyOff')}
                  </Badge>
                )}
              </div>
              <p className="truncate text-[11.5px] text-muted-foreground" title={engine.detail}>
                {engine.detail || t('settings.search.noDetail')}
              </p>
            </div>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
              {engine.elapsedMs > 0 ? `${engine.elapsedMs}ms` : '—'}
            </span>
          </div>
        ))}
      </div>

      {status && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('settings.search.orderHint')}
        </p>
      )}

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-[15px] font-semibold">{t('settings.search.testTitle')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t('settings.search.testDesc')}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Input
            data-testid="search-test-input"
            value={query}
            placeholder={t('settings.search.testPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runTest()
            }}
          />
          <Button
            data-testid="search-test-run"
            disabled={testing || !query.trim()}
            onClick={() => void runTest()}
          >
            {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
            {t('settings.search.testRun')}
          </Button>
        </div>

        {result && (
          <div data-testid="search-test-result" className="mt-3 rounded-md border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
              {result.engine ? (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {t('settings.search.hitEngine', {
                    engine: t(`settings.search.engine.${result.engine as SearchEngineName}`)
                  })}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-destructive/40 px-1.5 py-0 text-[10px] text-destructive"
                >
                  {t('settings.search.allFailed')}
                </Badge>
              )}
              <span className="font-mono">{result.elapsedMs}ms</span>
              <span>{t('settings.search.hitCount', { count: result.hits.length })}</span>
            </div>
            {result.hits.length > 0 && (
              <ol className="mt-2 space-y-1.5">
                {result.hits.map((hit) => (
                  <li key={hit.url} className="text-[12.5px] leading-snug">
                    <span className="font-medium">{hit.title}</span>
                    <span className="ml-1 break-all font-mono text-[10.5px] text-muted-foreground">
                      {hit.url}
                    </span>
                    {hit.snippet && (
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">{hit.snippet}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {result.errors.length > 0 && (
              <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                {result.errors.map((e) => `${e.engine}: ${e.detail ?? e.error ?? ''}`).join(' · ')}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-6 rounded-md border border-border bg-surface-soft/50 p-3">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
          <Globe className="size-3.5" />
          {t('settings.search.toolHintTitle')}
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
          {t('settings.search.toolHint')}
        </p>
      </div>
    </div>
  )
}
