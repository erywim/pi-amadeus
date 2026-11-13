import { load } from 'cheerio'
import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { SEARCH_ENGINES, type SearchAttemptError, type SearchEngineName, type SearchStatus } from '@pi-amadeus/shared'
import { fetchJson, fetchText } from './net.ts'

/** 结构化 API 优先，免密钥网页搜索作降级；网络/验证页故障绝不能冒充「没有匹配」。 */
export const searchToolSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 2000, description: '搜索关键词' }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: '结果条数，默认 5' })),
  freshness: Type.Optional(
    Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month'), Type.Literal('year')], {
      description: '最近一段时间的内容；只使用支持此条件的引擎，不把旧结果冒充实时信息'
    })
  )
})
type SearchArgs = Static<typeof searchToolSchema>

export interface SearchHit {
  title: string
  url: string
  snippet: string
  engine: SearchEngineName
}

export { SEARCH_ENGINES }
export type SearchEndpoints = Record<SearchEngineName, string>
export const DEFAULT_SEARCH_ENDPOINTS: SearchEndpoints = {
  tavily: 'https://api.tavily.com/search',
  bing: 'https://cn.bing.com/search',
  so: 'https://www.so.com/s',
  sogou: 'https://www.sogou.com/web',
  duckduckgo: 'https://html.duckduckgo.com/html/'
}

export interface SearchOptions {
  tavilyKey?: string
  proxy?: string
  engine?: SearchEngineName
  freshness?: 'day' | 'week' | 'month' | 'year'
  endpoints?: Partial<SearchEndpoints>
  signal?: AbortSignal
  /** 整条降级链共用预算，不能把四个引擎的超时累加给用户。 */
  timeoutMs?: number
}
export interface SearchOutcome {
  status: SearchStatus
  hits: SearchHit[]
  errors: SearchAttemptError[]
}

const ENGINE_TIMEOUT_MS = 8000
const SEARCH_TIMEOUT_MS = 20_000

class EngineError extends Error {
  readonly code: SearchAttemptError['code']
  constructor(code: SearchAttemptError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function createSearchTool(opts: SearchOptions): AgentTool<typeof searchToolSchema> {
  return {
    name: 'search',
    label: '联网搜索',
    description:
      '搜索互联网获取实时信息，返回真实标题、链接与摘要。需要原文时用 fetch_url 打开链接核对；' +
      '只在实际结果支持时回答并附来源，搜索失败不能编造结果。',
    parameters: searchToolSchema,
    execute: async (_toolCallId, params: SearchArgs, signal) => {
      const signals = [opts.signal, signal].filter((item): item is AbortSignal => Boolean(item))
      const outcome = await runSearch(params.query, params.maxResults ?? 5, {
        ...opts,
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
        ...(params.freshness ? { freshness: params.freshness } : {})
      })
      if (outcome.status === 'failed') {
        // 全链故障 → 真正的工具错误，Agent 与工具卡都不能显示「搜索成功」。
        throw new Error(`搜索不可用：${outcome.errors.map((item) => `${item.engine}: ${item.error}`).join('；')}`)
      }
      const text = outcome.hits.length
        ? outcome.hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join('\n')
        : `搜索已完成，未找到与「${params.query}」匹配的结果。请换关键词，不要编造来源。`
      return {
        content: [{ type: 'text', text }],
        details: {
          query: params.query,
          status: outcome.status,
          count: outcome.hits.length,
          engine: outcome.hits[0]?.engine,
          errors: outcome.errors
        }
      }
    }
  }
}

export async function runSearch(query: string, maxResults: number, opts: SearchOptions): Promise<SearchOutcome> {
  opts.signal?.throwIfAborted()
  const trimmed = query.trim()
  if (!trimmed || trimmed.length > 2000) throw new Error('搜索关键词须为 1–2000 字符')
  if (!Number.isFinite(maxResults)) throw new Error('maxResults 必须是有限数字')
  const limit = Math.min(10, Math.max(1, Math.floor(maxResults)))
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(opts.timeoutMs ?? SEARCH_TIMEOUT_MS)))
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const options = { ...opts, signal }
  const order = opts.engine ? [opts.engine] : SEARCH_ENGINES.filter((engine) => engine !== 'tavily' || opts.tavilyKey)
  const errors: SearchAttemptError[] = []
  let completedEmpty = false
  for (const engine of order) {
    opts.signal?.throwIfAborted()
    if (timeout.aborted) break
    try {
      if (opts.freshness && (engine === 'so' || engine === 'sogou')) {
        throw new EngineError('unsupported', '该引擎不支持时效条件，未使用不限时间的结果替代')
      }
      const hits = await searchWith(engine, trimmed, limit, options)
      opts.signal?.throwIfAborted()
      if (hits.length) return { status: 'success', hits, errors }
      // 引擎明确表示无匹配 → 正常空结果；仍尝试下一个，因为索引覆盖不同。
      completedEmpty = true
      errors.push({ engine, code: 'empty', error: '无结果' })
    } catch (error) {
      // 用户取消不能变成普通搜索失败，也不能继续启动下一个网络请求。
      opts.signal?.throwIfAborted()
      errors.push({
        engine,
        code: timeout.aborted ? 'timeout' : error instanceof EngineError ? error.code : 'request_failed',
        error: timeout.aborted ? '搜索整体时间预算已耗尽' : error instanceof Error ? error.message : String(error)
      })
      if (timeout.aborted) break
    }
  }
  return { status: completedEmpty ? 'empty' : 'failed', hits: [], errors }
}

function endpointUrl(engine: SearchEngineName, opts: SearchOptions, params: Record<string, string>): string {
  const url = new URL(opts.endpoints?.[engine] ?? DEFAULT_SEARCH_ENDPOINTS[engine])
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('搜索端点必须是 http(s) 地址')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.href
}

function engineFetch(opts: SearchOptions): { proxy?: string; signal?: AbortSignal; timeoutMs: number; maxBytes: number } {
  return {
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeoutMs: ENGINE_TIMEOUT_MS,
    maxBytes: 2_000_000
  }
}

const JUNK_TITLE = /^(其他人还搜了|相关搜索|大家还在搜|相关推荐|热搜榜?|全网热搜|猜你(喜欢|想搜)|查看更多)|的最新相关消息|相关消息$|_?热搜榜$|^搜索热词/
const ENGINE_HOSTS = new Set(['www.bing.com', 'cn.bing.com', 'www.so.com', 'www.sogou.com', 'duckduckgo.com', 'html.duckduckgo.com'])

function normalizeResultUrl(raw: string, base: string): string | null {
  try {
    let url = base ? new URL(raw, base) : new URL(raw)
    if (url.hostname.endsWith('bing.com') && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u')
      if (encoded?.startsWith('a1')) url = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'))
    } else if (url.hostname.endsWith('duckduckgo.com') && url.searchParams.has('uddg')) {
      url = new URL(url.searchParams.get('uddg')!)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (ENGINE_HOSTS.has(url.hostname) && url.pathname !== '/link') return null
    url.hash = ''
    // 只删已知追踪参数；文档 id、签名与搜索跳转 token 都是链接身份，绝不能统统删掉。
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return null
  }
}

function finalizeHits(hits: SearchHit[], base: string, maxResults: number): SearchHit[] {
  const seen = new Set<string>()
  const output: SearchHit[] = []
  for (const hit of hits) {
    const title = hit.title.replace(/\s+/g, ' ').trim()
    const url = normalizeResultUrl(hit.url, base)
    if (!title || !url || JUNK_TITLE.test(title) || seen.has(url)) continue
    seen.add(url)
    output.push({ ...hit, title, url, snippet: hit.snippet.replace(/\s+/g, ' ').trim().slice(0, 500) })
    if (output.length >= maxResults) break
  }
  return output
}

function parseSearchHtml(html: string, engine: Exclude<SearchEngineName, 'tavily'>, base: string, maxResults: number): SearchHit[] {
  const $ = load(html)
  const pageText = $('body').text()
  if ($('form[action*="captcha"], #captcha, .g-recaptcha, #b_captcha').length ||
    /请输入验证码|完成验证|验证您是人类|unusual traffic|verify you are human|automated requests|anomaly-modal/i.test(pageText)) {
    throw new EngineError('blocked', '搜索引擎要求人工验证，未绕过验证')
  }
  const selectors = { bing: '.b_algo', so: '.res-list', sogou: '.vrwrap', duckduckgo: '.result' }
  const blocks = $(selectors[engine])
  const hits: SearchHit[] = []
  blocks.each((_index, element) => {
    const block = $(element)
    const anchor = engine === 'duckduckgo' ? block.find('a.result__a').first() : block.find('h2 a, h3 a').first()
    const url = anchor.attr('href')
    if (!url) return
    const snippet = block.find(engine === 'bing'
      ? '.b_caption p, p[class*="b_lineclamp"]'
      : engine === 'so' ? '.res-desc, .res-list-summary, .res-rich'
        : engine === 'sogou' ? '.text-layout, .space-txt' : '.result__snippet').first().text()
    hits.push({ title: anchor.text(), url, snippet, engine })
  })
  const output = finalizeHits(hits, base, maxResults)
  if (output.length || blocks.length || /no results|未找到|没有找到|没有结果|找不到|无相关结果/i.test(pageText)) return output
  throw new EngineError('parse_failed', '页面没有可识别的搜索结果（可能改版或被拦截），不能确认无匹配')
}

async function searchWith(engine: SearchEngineName, query: string, maxResults: number, opts: SearchOptions): Promise<SearchHit[]> {
  if (engine === 'tavily') {
    if (!opts.tavilyKey) throw new EngineError('unconfigured', '未配置 TAVILY_API_KEY')
    const raw = await fetchJson(endpointUrl(engine, opts, {}), {
      method: 'POST',
      body: {
        api_key: opts.tavilyKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
        ...(opts.freshness ? { time_range: opts.freshness } : {})
      },
      ...engineFetch(opts)
    }) as { results?: Array<{ title?: string; url?: string; content?: string }>; error?: unknown }
    if (!Array.isArray(raw.results)) throw new EngineError('parse_failed', 'Tavily 响应缺少 results 数组')
    return finalizeHits(raw.results.map((hit) => ({ title: hit.title ?? '', url: hit.url ?? '', snippet: hit.content ?? '', engine })), '', maxResults)
  }
  const params: Record<string, string> = engine === 'sogou' ? { query } : { q: query }
  if (engine === 'bing') {
    params.setlang = 'zh-CN'
    params.count = String(Math.max(10, maxResults))
    if (opts.freshness) params.filters = `ex1:"${{ day: 'ez1', week: 'ez2', month: 'ez3', year: 'ez5' }[opts.freshness]}"`
  } else if (engine === 'duckduckgo' && opts.freshness) {
    params.df = { day: 'd', week: 'w', month: 'm', year: 'y' }[opts.freshness]
  }
  const url = endpointUrl(engine, opts, params)
  const response = await fetchText(url, engineFetch(opts))
  return parseSearchHtml(response.text, engine, response.finalUrl || url, maxResults)
}
