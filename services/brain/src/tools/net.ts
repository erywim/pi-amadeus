import { proxyFetch } from '../llm.ts'

/**
 * 工具用 HTTP 客户端：支持 Clash 代理（与 LLM 请求同一 ProxyAgent 模式）、
 * 显式超时（默认 15s）、外层 abort 信号合成；非 2xx 抛出中文错误。
 */

export interface FetchJsonOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  proxy?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { method = 'GET', body, proxy, signal, timeoutMs = 15_000 } = opts
  const fetchFn = proxy ? proxyFetch(proxy) : fetch
  const res = await fetchFn(url, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
  })
  if (!res.ok) throw new Error(`请求失败: HTTP ${res.status}（${url}）`)
  return (await res.json()) as unknown
}
