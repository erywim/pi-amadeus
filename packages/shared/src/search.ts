/**
 * 联网搜索的跨端类型：设置页的「联网搜索」面板读取真实探测结果，
 * 不做任何本地猜测（可达性是运行时事实，不能写死）。
 */

export type SearchEngineName = 'tavily' | 'bing' | 'so' | 'sogou' | 'duckduckgo'

/** 引擎顺序（与后端降级顺序一致） */
export const SEARCH_ENGINES: SearchEngineName[] = ['tavily', 'bing', 'so', 'sogou', 'duckduckgo']

export type SearchStatus = 'success' | 'empty' | 'failed'

export interface SearchAttemptError {
  engine: SearchEngineName
  code: 'empty' | 'unconfigured' | 'blocked' | 'parse_failed' | 'request_failed' | 'timeout' | 'unsupported'
  error: string
}

export interface SearchEngineStatus {
  engine: SearchEngineName
  /** 该引擎在当前网络下是否真的返回了结果 */
  ok: boolean
  elapsedMs: number
  /** 成功时是首条结果标题，失败时是真实失败原因 */
  detail: string
}

export interface SearchDiagnostics {
  checkedAt: number
  /** 全部引擎并发探测的总耗时 */
  elapsedMs: number
  tavilyConfigured: boolean
  /** 与聊天工具共用的实际网络路径，不返回代理凭证或完整 URL。 */
  network: 'direct' | 'proxy'
  engines: SearchEngineStatus[]
}

export interface SearchHitPayload {
  title: string
  url: string
  snippet: string
  engine: string
}

export interface SearchTestResponse {
  query: string
  status: SearchStatus
  elapsedMs: number
  /** 实际返回结果的引擎（首个命中来源）；全部失败时为 null */
  engine: string | null
  hits: SearchHitPayload[]
  /** 逐引擎失败原因（成功返回时也保留前面的失败记录） */
  errors: SearchAttemptError[]
}

export interface FetchPageResponse {
  url: string
  title: string
  contentType: string
  elapsedMs: number
  chars: number
  truncated: boolean
  text: string
}
