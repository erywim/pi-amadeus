import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { fetchJson } from './net.ts'

/**
 * 联网搜索：有 Tavily 密钥走 Tavily（质量高），否则回退 DuckDuckGo
 * 即时答案 API（免密钥）。空结果不是错误——返回"未找到"让 LLM 照常回答。
 */

export const searchToolSchema = Type.Object({
  query: Type.String({ description: '搜索关键词' }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: '结果条数，默认 3' }))
})

type SearchArgs = Static<typeof searchToolSchema>

interface SearchHit {
  title: string
  url: string
  snippet: string
}

export function createSearchTool(opts: { tavilyKey?: string; proxy?: string }): AgentTool<typeof searchToolSchema> {
  return {
    name: 'search',
    label: '联网搜索',
    description: '搜索互联网获取实时信息（新闻、事实核查、时效性内容）。LLM 知识截止后的问题应使用。',
    parameters: searchToolSchema,
    execute: async (_toolCallId, params: SearchArgs) => {
      const maxResults = params.maxResults ?? 3
      const hits = opts.tavilyKey
        ? await searchTavily(params.query, maxResults, opts.tavilyKey, opts.proxy)
        : await searchDuckDuckGo(params.query, maxResults, opts.proxy)

      if (hits.length === 0) {
        return {
          content: [{ type: 'text', text: `未找到与"${params.query}"相关的结果` }],
          details: { query: params.query, count: 0 }
        }
      }
      const text = hits
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
        .join('\n')
      return {
        content: [{ type: 'text', text }],
        details: { query: params.query, count: hits.length }
      }
    }
  }
}

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string }[]
}

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
  proxy?: string
): Promise<SearchHit[]> {
  const json = (await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    body: { api_key: apiKey, query, max_results: maxResults, search_depth: 'basic' },
    proxy
  })) as TavilyResponse
  return (json.results ?? []).map((r) => ({
    title: r.title ?? '(无标题)',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 300)
  }))
}

interface DuckDuckGoResponse {
  AbstractText?: string
  AbstractURL?: string
  RelatedTopics?: ({ Text?: string; FirstURL?: string } | { Topics?: { Text?: string; FirstURL?: string }[] })[]
}

async function searchDuckDuckGo(query: string, maxResults: number, proxy?: string): Promise<SearchHit[]> {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const json = (await fetchJson(url, { proxy })) as DuckDuckGoResponse
  const hits: SearchHit[] = []
  if (json.AbstractText) {
    hits.push({ title: '即时答案', url: json.AbstractURL ?? '', snippet: json.AbstractText.slice(0, 300) })
  }
  for (const topic of json.RelatedTopics ?? []) {
    if (hits.length >= maxResults) break
    if ('Text' in topic && topic.Text) {
      hits.push({ title: '相关结果', url: topic.FirstURL ?? '', snippet: topic.Text.slice(0, 300) })
    } else if ('Topics' in topic && topic.Topics) {
      for (const sub of topic.Topics) {
        if (hits.length >= maxResults) break
        if (sub.Text) hits.push({ title: '相关结果', url: sub.FirstURL ?? '', snippet: sub.Text.slice(0, 300) })
      }
    }
  }
  return hits
}
