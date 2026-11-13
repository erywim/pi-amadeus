import { Hono } from 'hono'
import type { SearchDiagnostics, SearchEngineName } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import { assertPublicHttpUrl } from '../tools/fetchUrl.ts'
import { fetchText, htmlTitle, htmlToText } from '../tools/net.ts'
import { runSearch, SEARCH_ENGINES } from '../tools/search.ts'

/**
 * 联网能力的可观测入口（设置页「联网搜索」用）：
 * - GET  /api/search/status   各引擎在当前网络下的真实可达性（逐个发一次探测请求）
 * - POST /api/search/test     用给定关键词真的搜一次，返回命中与逐引擎失败原因
 * - POST /api/search/fetch    读一个网页正文（排查「搜到但打不开」）
 *
 * 这些接口不做缓存：用户点「测试」时要看到此刻的真实结果，
 * 而不是上一次（可能是别的网络环境下）的结论。
 */
export function searchRoutes(cfg: BrainConfig): Hono {
  const app = new Hono()

  app.get('/search/status', async (c) => {
    const probe = c.req.query('q') || '今天 新闻'
    const diagnostics = await probeEngines(cfg, probe)
    return c.json(diagnostics)
  })

  app.post('/search/test', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { query?: unknown; engine?: unknown; maxResults?: unknown; freshness?: unknown }
      | null
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (!query) return c.json({ error: 'query 必填' }, 400)
    const engine =
      typeof body?.engine === 'string' && (SEARCH_ENGINES as string[]).includes(body.engine)
        ? (body.engine as SearchEngineName)
        : undefined
    const maxResults =
      typeof body?.maxResults === 'number' ? Math.min(10, Math.max(1, Math.floor(body.maxResults))) : 5
    const freshness =
      body?.freshness === 'day' ||
      body?.freshness === 'week' ||
      body?.freshness === 'month' ||
      body?.freshness === 'year'
        ? body.freshness
        : undefined
    const startedAt = Date.now()
    const outcome = await runSearch(query, maxResults, {
      ...(cfg.tools.tavilyKey ? { tavilyKey: cfg.tools.tavilyKey } : {}),
      endpoints: cfg.tools.searchEndpoints,
      ...(engine ? { engine } : {}),
      ...(freshness ? { freshness } : {})
    })
    return c.json({
      query,
      elapsedMs: Date.now() - startedAt,
      engine: outcome.hits[0]?.engine ?? null,
      hits: outcome.hits.map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        engine: hit.engine
      })),
      errors: outcome.errors
    })
  })

  app.post('/search/fetch', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown; maxChars?: unknown } | null
    const url = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!url) return c.json({ error: 'url 必填' }, 400)
    try {
      assertPublicHttpUrl(url)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
    const maxChars =
      typeof body?.maxChars === 'number' ? Math.min(40_000, Math.max(500, Math.floor(body.maxChars))) : 4000
    const startedAt = Date.now()
    try {
      const res = await fetchText(url, { timeoutMs: 20_000, maxBytes: 3_000_000 })
      const isHtml = res.contentType.includes('html') || /^\s*<(!doctype|html)/i.test(res.text)
      const text = isHtml ? htmlToText(res.text) : res.text.trim()
      return c.json({
        url: res.finalUrl,
        title: isHtml ? htmlTitle(res.text) : '',
        contentType: res.contentType,
        elapsedMs: Date.now() - startedAt,
        chars: text.length,
        truncated: text.length > maxChars,
        text: text.slice(0, maxChars)
      })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt },
        502
      )
    }
  })

  return app
}

/**
 * 逐个引擎发一次最小搜索，返回真实可达性。
 * 并发探测：串行会让「全都不可达」的情况等 4 个超时（约 48s），
 * 用户点一次「检查」不该等这么久。
 */
async function probeEngines(cfg: BrainConfig, query: string): Promise<SearchDiagnostics> {
  const startedAt = Date.now()
  const engines = await Promise.all(
    SEARCH_ENGINES.map(async (engine) => {
      if (engine === 'tavily' && !cfg.tools.tavilyKey) {
        return { engine, ok: false, elapsedMs: 0, detail: '未配置 TAVILY_API_KEY' }
      }
      const t0 = Date.now()
      try {
        const outcome = await runSearch(query, 1, {
          engine,
          endpoints: cfg.tools.searchEndpoints,
          ...(cfg.tools.tavilyKey ? { tavilyKey: cfg.tools.tavilyKey } : {})
        })
        const hit = outcome.hits[0]
        return {
          engine,
          ok: Boolean(hit),
          elapsedMs: Date.now() - t0,
          ...(hit ? { detail: hit.title.slice(0, 80) } : { detail: outcome.errors[0]?.error ?? '无结果' })
        }
      } catch (error) {
        return {
          engine,
          ok: false,
          elapsedMs: Date.now() - t0,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
  return {
    checkedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    tavilyConfigured: Boolean(cfg.tools.tavilyKey),
    engines
  }
}
