import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { SearchEngineName } from '@pi-amadeus/shared'
import { decodeEntities, fetchJson, fetchText } from './net.ts'

/**
 * 联网搜索：多引擎自动降级，保证「配不配密钥都能搜到东西」。
 *
 * 顺序：Tavily（配了密钥才有，结果质量最好）→ Bing → 360 → 搜狗 → DuckDuckGo。
 * 后端站点在不同网络环境下可达性差异极大（例如 DuckDuckGo 在国内完全连不上），
 * 单引擎实现等于「能不能搜全看运气」；这里逐个尝试，任一成功即返回，
 * 全部失败时把每个引擎的失败原因一并回给模型，便于它换个说法或如实告知用户。
 *
 * 空结果不是错误：返回「未找到」让 LLM 照常回答，不编造。
 */

export const searchToolSchema = Type.Object({
  query: Type.String({ description: '搜索关键词' }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: '结果条数，默认 5' })),
  freshness: Type.Optional(
    Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month'), Type.Literal('year')], {
      description: '只要最近一段时间的内容（新闻/时效性问题用），默认不限'
    })
  )
})

type SearchArgs = Static<typeof searchToolSchema>

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /** 结果来自哪个引擎（调试与「来源可信度」判断用） */
  engine: string
}

/** 引擎顺序与 shared 的 SEARCH_ENGINES 保持一致（这里是运行时使用的那份） */
export const SEARCH_ENGINES: SearchEngineName[] = ['tavily', 'bing', 'so', 'sogou', 'duckduckgo']

/** 引擎端点：默认官方地址；可用环境变量指向镜像/自建代理（也用于 E2E 的本地 mock） */
export interface SearchEndpoints {
  bing: string
  so: string
  sogou: string
  duckduckgo: string
  tavily: string
}

export const DEFAULT_SEARCH_ENDPOINTS: SearchEndpoints = {
  bing: 'https://cn.bing.com/search',
  so: 'https://www.so.com/s',
  sogou: 'https://www.sogou.com/web',
  duckduckgo: 'https://api.duckduckgo.com/',
  tavily: 'https://api.tavily.com/search'
}

export interface SearchOptions {
  tavilyKey?: string
  proxy?: string
  /** 强制只用某个引擎（设置页「测试搜索」用）；不传则按默认顺序降级 */
  engine?: SearchEngineName
  /** 时效过滤（新闻类查询用） */
  freshness?: 'day' | 'week' | 'month' | 'year'
  /** 端点覆盖（未给的走官方地址） */
  endpoints?: Partial<SearchEndpoints>
  signal?: AbortSignal
}

/** 单引擎超时：搜索是交互路径，慢引擎不该拖住整回合 */
const ENGINE_TIMEOUT_MS = 12_000

export function createSearchTool(opts: SearchOptions): AgentTool<typeof searchToolSchema> {
  return {
    name: 'search',
    label: '联网搜索',
    description:
      '搜索互联网获取实时信息（新闻、事实、时效性内容、模型知识截止之后的事）。' +
      '返回标题、链接与摘要；需要正文时再用 fetch_url 打开具体链接。',
    parameters: searchToolSchema,
    execute: async (_toolCallId, params: SearchArgs) => {
      const maxResults = params.maxResults ?? 5
      const outcome = await runSearch(params.query, maxResults, {
        ...opts,
        ...(params.freshness ? { freshness: params.freshness } : {})
      })
      if (outcome.hits.length === 0) {
        const detail = outcome.errors.length > 0
          ? `（引擎错误：${outcome.errors.map((e) => `${e.engine}: ${e.error}`).join('；')}）`
          : ''
        return {
          content: [{ type: 'text', text: `未找到与"${params.query}"相关的结果${detail}` }],
          details: { query: params.query, count: 0, errors: outcome.errors }
        }
      }
      const text =
        outcome.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n') +
        `\n\n（来源：${outcome.hits[0]?.engine ?? ''}）`
      return {
        content: [{ type: 'text', text }],
        details: {
          query: params.query,
          count: outcome.hits.length,
          engine: outcome.hits[0]?.engine,
          errors: outcome.errors
        }
      }
    }
  }
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** 本次尝试过的引擎及其失败原因（成功返回时也保留，便于诊断） */
  errors: Array<{ engine: string; error: string }>
}

/**
 * 依次尝试各引擎，任一返回非空结果即停止。
 * 注意：只有「空结果」与「抛错」会继续降级；结果为空说明引擎可达但没有内容，
 * 仍继续尝试下一个引擎，因为不同引擎的索引覆盖差异很大。
 */
export async function runSearch(
  query: string,
  maxResults: number,
  opts: SearchOptions
): Promise<SearchOutcome> {
  const errors: Array<{ engine: string; error: string }> = []
  const all = opts.tavilyKey ? SEARCH_ENGINES : SEARCH_ENGINES.filter((name) => name !== 'tavily')
  const order: SearchEngineName[] = opts.engine ? [opts.engine] : all

  for (const engine of order) {
    try {
      const hits = await searchWith(engine, query, maxResults, opts)
      if (hits.length > 0) return { hits: hits.slice(0, maxResults), errors }
      errors.push({ engine, error: '无结果' })
    } catch (error) {
      errors.push({ engine, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { hits: [], errors }
}

function searchWith(
  engine: SearchEngineName,
  query: string,
  maxResults: number,
  opts: SearchOptions
): Promise<SearchHit[]> {
  switch (engine) {
    case 'tavily':
      if (!opts.tavilyKey) throw new Error('未配置密钥')
      return searchTavily(query, maxResults, opts.tavilyKey, opts)
    case 'bing':
      return searchBing(query, maxResults, opts)
    case 'so':
      return searchSo(query, maxResults, opts)
    case 'sogou':
      return searchSogou(query, maxResults, opts)
    case 'duckduckgo':
      return searchDuckDuckGo(query, maxResults, opts)
  }
}

/** 各引擎通用的 fetch 选项（超时 + 代理 + 外层取消） */
function engineFetch(opts: SearchOptions, timeoutMs = ENGINE_TIMEOUT_MS): {
  proxy?: string
  signal?: AbortSignal
  timeoutMs: number
} {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (opts.signal) signals.push(opts.signal)
  return {
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    // 外层 signal 与超时合成：用户点停止时搜索请求也要立刻结束
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    timeoutMs
  }
}

/** 取某引擎的端点（允许环境变量覆盖，未覆盖时用官方地址） */
function endpointOf(engine: keyof SearchEndpoints, opts: SearchOptions): string {
  return opts.endpoints?.[engine] ?? DEFAULT_SEARCH_ENDPOINTS[engine]
}

function decodeHits(hits: SearchHit[]): SearchHit[] {
  return hits.map((hit) => ({
    ...hit,
    title: decodeEntities(hit.title).replace(/\s+/g, ' ').trim(),
    snippet: decodeEntities(hit.snippet).replace(/\s+/g, ' ').trim()
  }))
}

/**
 * 搜索结果标题/摘要的取文：行内高亮标签（<em>/<strong>/<span>）必须直接删掉，
 * 不能换成空格——否则「Node.js 24.0 正式发布」会变成「Node.js 24 .0 正式 发布」，
 * 中文词被拆开既难读也影响模型理解。只有真正的块级边界才换成空格。
 */
function cleanText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|td|blockquote)>/gi, ' ')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
}

/**
 * 搜索结果里的「杂质」：相关搜索/推荐词块、站内跳转、以及把搜索引擎自己当结果。
 * 这些条目对模型没有信息量，混进去只会浪费上下文（360 与搜狗尤其多）。
 */
const JUNK_TITLE =
  /^(其他人还搜了|相关搜索|大家还在搜|相关推荐|热搜榜?|全网热搜|猜你(喜欢|想搜)|查看更多)|的最新相关消息|相关消息$|_?热搜榜$|^搜索热词/

function isJunk(hit: SearchHit, engineHost: string): boolean {
  if (!hit.title || JUNK_TITLE.test(hit.title)) return true
  if (!hit.url) return true
  try {
    const host = new URL(hit.url).hostname
    // 搜索引擎自己的站内链接（/s?q= 相关搜索、/link? 跳转）不是可读内容
    if (host === engineHost && !/\/link\?/.test(hit.url)) return true
  } catch {
    return true
  }
  return false
}

function finalizeHits(hits: SearchHit[], engineHost: string, maxResults: number): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of decodeHits(hits)) {
    if (out.length >= maxResults) break
    if (isJunk(hit, engineHost)) continue
    const key = hit.url.replace(/[#?].*$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

// ---------------- Tavily ----------------

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string }[]
}

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
  opts: SearchOptions
): Promise<SearchHit[]> {
  const fetchOpts = engineFetch(opts, 20_000)
  const json = (await fetchJson(endpointOf('tavily', opts), {
    method: 'POST',
    body: { api_key: apiKey, query, max_results: maxResults, search_depth: 'basic' },
    ...fetchOpts
  })) as TavilyResponse
  return finalizeHits(
    (json.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 400),
      engine: 'tavily'
    })),
    '',
    maxResults
  )
}

// ---------------- Bing ----------------

/**
 * Bing 网页结果：<li class="b_algo"> 块，标题在 <h2><a href>，摘要在 b_lineclamp/b_caption。
 * 先请求 RSS（结构化、稳定）只用于确认可达；正文摘要仍取 HTML（RSS 不带摘要）。
 */
async function searchBing(query: string, maxResults: number, opts: SearchOptions): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, setlang: 'zh-CN', count: String(Math.max(10, maxResults)) })
  if (opts.freshness) {
    // Bing 的新鲜度过滤：day/week/month/year → filters=ex1:"ezN"
    const map: Record<string, string> = { day: 'ez1', week: 'ez2', month: 'ez3', year: 'ez5' }
    params.set('filters', `ex1:"${map[opts.freshness] ?? 'ez3'}"`)
  }
  const res = await fetchText(`${endpointOf('bing', opts)}?${params.toString()}`, engineFetch(opts))
  // 解析阶段收全部候选（不提前按 maxResults 截断）：杂质块常在前面，
  // 提前截断会把真实结果一起丢掉。截断在 finalizeHits 里做。
  const hits: SearchHit[] = []
  const blocks = res.text.split(/<li class="b_algo"/).slice(1)
  for (const block of blocks) {
    const href =
      /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/.exec(block)?.[1] ?? /<a[^>]+href="(https?:[^"]+)"/.exec(block)?.[1]
    if (!href || !href.startsWith('http')) continue
    const titleHtml = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(block)?.[1] ?? ''
    const snippetHtml =
      /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ??
      /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ??
      ''
    const title = cleanText(titleHtml)
    if (!title) continue
    hits.push({ title, url: href, snippet: cleanText(snippetHtml).slice(0, 400), engine: 'bing' })
  }
  return finalizeHits(hits, 'cn.bing.com', maxResults)
}

// ---------------- 360 搜索 ----------------

/** 360：<ul class="result"><li class="res-list">，标题在 <h3><a href>，摘要在 .res-desc / .res-rich */
async function searchSo(query: string, maxResults: number, opts: SearchOptions): Promise<SearchHit[]> {
  const res = await fetchText(`${endpointOf('so', opts)}?q=${encodeURIComponent(query)}`, engineFetch(opts))
  const hits: SearchHit[] = []
  for (const block of res.text.split(/<li class="res-list"/).slice(1)) {
    const href =
      /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/.exec(block)?.[1] ?? /<a[^>]+href="(https?:[^"]+)"/.exec(block)?.[1]
    if (!href || !href.startsWith('http')) continue
    const titleHtml = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(block)?.[1] ?? ''
    const snippetHtml =
      /<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ??
      /<span class="res-list-summary"[^>]*>([\s\S]*?)<\/span>/.exec(block)?.[1] ??
      /<div class="res-rich[^"]*"[^>]*>([\s\S]{0,1200}?)<\/div>/.exec(block)?.[1] ??
      ''
    const title = cleanText(titleHtml)
    if (!title) continue
    hits.push({ title, url: href, snippet: cleanText(snippetHtml).slice(0, 400), engine: 'so' })
  }
  return finalizeHits(hits, 'www.so.com', maxResults)
}

// ---------------- 搜狗 ----------------

/** 搜狗：<div class="vrwrap">，标题在 h3 a，摘要在 .text-layout / .space-txt */
async function searchSogou(query: string, maxResults: number, opts: SearchOptions): Promise<SearchHit[]> {
  const res = await fetchText(`${endpointOf('sogou', opts)}?query=${encodeURIComponent(query)}`, engineFetch(opts))
  const hits: SearchHit[] = []
  for (const block of res.text.split(/<div class="vrwrap"/).slice(1)) {
    const href = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/.exec(block)?.[1]
    if (!href) continue
    const titleHtml = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(block)?.[1] ?? ''
    const snippetHtml = /<div class="text-layout"[^>]*>([\s\S]{0,800}?)<\/div>/.exec(block)?.[1] ?? ''
    const title = cleanText(titleHtml)
    if (!title) continue
    // 搜狗的结果链接是站内跳转（/link?url=...），补成绝对地址才能点开
    const url = href.startsWith('http') ? href : `https://www.sogou.com${href.startsWith('/') ? '' : '/'}${href}`
    hits.push({ title, url, snippet: cleanText(snippetHtml).slice(0, 400), engine: 'sogou' })
  }
  // 搜狗的 /link? 跳转是真实结果（不是相关搜索），保留；只挡相关搜索那类
  return finalizeHits(hits, '', maxResults)
}

// ---------------- DuckDuckGo Instant Answer ----------------

interface DuckDuckGoResponse {
  AbstractText?: string
  AbstractURL?: string
  RelatedTopics?: ({ Text?: string; FirstURL?: string } | { Topics?: { Text?: string; FirstURL?: string }[] })[]
}

async function searchDuckDuckGo(query: string, maxResults: number, opts: SearchOptions): Promise<SearchHit[]> {
  const base = endpointOf('duckduckgo', opts)
  const json = (await fetchJson(
    `${base}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    engineFetch(opts)
  )) as DuckDuckGoResponse
  const hits: SearchHit[] = []
  if (json.AbstractText) {
    hits.push({
      title: '即时答案',
      url: json.AbstractURL ?? '',
      snippet: json.AbstractText.slice(0, 400),
      engine: 'duckduckgo'
    })
  }
  // 同样先收全部候选，交给 finalizeHits 过滤/去重/截断
  for (const topic of json.RelatedTopics ?? []) {
    if ('Text' in topic && topic.Text) {
      hits.push({ title: '相关结果', url: topic.FirstURL ?? '', snippet: topic.Text.slice(0, 400), engine: 'duckduckgo' })
    } else if ('Topics' in topic && topic.Topics) {
      for (const sub of topic.Topics) {
        if (sub.Text) {
          hits.push({ title: '相关结果', url: sub.FirstURL ?? '', snippet: sub.Text.slice(0, 400), engine: 'duckduckgo' })
        }
      }
    }
  }
  return finalizeHits(hits, '', maxResults)
}
