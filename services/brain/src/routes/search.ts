import { Hono } from 'hono'
import type { SearchDiagnostics, SearchEngineName } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import { resolveTarget } from '../conversation.ts'
import type { Db } from '../db.ts'
import { assertPublicHttpUrl, readPublicPage } from '../tools/fetchUrl.ts'
import { runSearch, SEARCH_ENGINES, type SearchOptions } from '../tools/search.ts'
import { searchOptions } from '../tools/searchConfig.ts'

/** 诊断与聊天工具共用网络配置、搜索与网页提取器，结果只反映本次真实请求。 */
export function searchRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  async function network(signal: AbortSignal): Promise<SearchOptions> {
    const user = await db.getCurrentUser()
    const target = user ? await resolveTarget(cfg, db, user.id) : null
    return searchOptions(cfg, target?.proxy, signal)
  }

  app.get('/search/status', async (c) => {
    const query = (c.req.query('q') || 'Node.js release').trim()
    if (query.length > 2000) return c.json({ error: '关键词过长（上限 2000 字符）' }, 400)
    const options = await network(c.req.raw.signal)
    const startedAt = Date.now()
    const engines = await Promise.all(SEARCH_ENGINES.map(async (engine) => {
      const t0 = Date.now()
      const outcome = await runSearch(query, 1, { ...options, engine })
      return {
        engine,
        ok: outcome.status === 'success',
        elapsedMs: Date.now() - t0,
        detail: outcome.hits[0]?.title ?? outcome.errors[0]?.error ?? '无结果'
      }
    }))
    const diagnostics: SearchDiagnostics = {
      checkedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      tavilyConfigured: Boolean(options.tavilyKey),
      network: options.proxy ? 'proxy' : 'direct',
      engines
    }
    return c.json(diagnostics)
  })

  app.post('/search/test', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (!query || query.length > 2000) return c.json({ error: 'query 必须为 1–2000 字符' }, 400)
    if (body?.engine !== undefined && !(SEARCH_ENGINES as unknown[]).includes(body.engine)) {
      return c.json({ error: '不支持的搜索引擎' }, 400)
    }
    if (body?.maxResults !== undefined && (typeof body.maxResults !== 'number' || !Number.isFinite(body.maxResults))) {
      return c.json({ error: 'maxResults 必须是有限数字' }, 400)
    }
    if (body?.freshness !== undefined && !['day', 'week', 'month', 'year'].includes(String(body.freshness))) {
      return c.json({ error: '不支持的时效条件' }, 400)
    }
    const options = await network(c.req.raw.signal)
    const startedAt = Date.now()
    const outcome = await runSearch(query, typeof body?.maxResults === 'number' ? body.maxResults : 5, {
      ...options,
      ...(body?.engine ? { engine: body.engine as SearchEngineName } : {}),
      ...(body?.freshness ? { freshness: body.freshness as SearchOptions['freshness'] } : {})
    })
    return c.json({
      query,
      status: outcome.status,
      elapsedMs: Date.now() - startedAt,
      engine: outcome.hits[0]?.engine ?? null,
      hits: outcome.hits,
      errors: outcome.errors
    })
  })

  app.post('/search/fetch', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const url = typeof body?.url === 'string' ? body.url.trim() : ''
    try {
      assertPublicHttpUrl(url)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
    if (body?.maxChars !== undefined && (typeof body.maxChars !== 'number' || !Number.isFinite(body.maxChars))) {
      return c.json({ error: 'maxChars 必须是有限数字' }, 400)
    }
    const options = await network(c.req.raw.signal)
    const startedAt = Date.now()
    try {
      const page = await readPublicPage(url, {
        proxy: options.proxy,
        signal: options.signal,
        maxChars: typeof body?.maxChars === 'number' ? Math.min(40_000, Math.max(500, Math.floor(body.maxChars))) : 4000
      })
      return c.json({ ...page, elapsedMs: Date.now() - startedAt })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }, 502)
    }
  })
  return app
}
