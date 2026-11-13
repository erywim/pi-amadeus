import { proxyFetch } from '../llm.ts'

/**
 * 工具用 HTTP 客户端：支持 Clash 代理（与 LLM 请求同一 ProxyAgent 模式）、
 * 显式超时（默认 15s）、外层 abort 信号合成；非 2xx 抛出中文错误。
 *
 * 错误信息里带底层 cause（如 ENOTFOUND / UND_ERR_CONNECT_TIMEOUT）：
 * 工具失败时模型与用户看到的必须是「哪个站点、因为什么失败」，
 * 而不是一句没有信息量的 "fetch failed"。
 */

export interface FetchJsonOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  proxy?: string
  signal?: AbortSignal
  timeoutMs?: number
  headers?: Record<string, string>
}

/** 浏览器 UA：搜索端点与常见站点会拒绝无 UA 的请求或返回移动版页面 */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 底层网络错误转成可读中文：超时 / DNS / 拒绝连接各有不同处置方式 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  const code = cause?.code ?? ''
  if (error.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return '连接超时'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败'
  if (code === 'ECONNREFUSED') return '连接被拒绝'
  if (code === 'ECONNRESET') return '连接被重置'
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return '证书校验失败'
  return cause?.message ? `${error.message}（${cause.message}）` : error.message
}

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
}

export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { method = 'GET', body, proxy, signal, timeoutMs = 15_000, headers } = opts
  const fetchFn = proxy ? proxyFetch(proxy) : fetch
  let res: Response
  try {
    res = await fetchFn(url, {
      method,
      headers: {
        'User-Agent': BROWSER_UA,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: composeSignal(signal, timeoutMs)
    })
  } catch (error) {
    throw new Error(`${describeFetchError(error)}（${new URL(url).host}）`)
  }
  if (!res.ok) throw new Error(`请求失败: HTTP ${res.status}（${new URL(url).host}）`)
  return (await res.json()) as unknown
}

export interface FetchTextOptions {
  proxy?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** 最多读取的响应字节数（超出截断，避免把大文件读进内存） */
  maxBytes?: number
  headers?: Record<string, string>
}

export interface FetchTextResult {
  /** 原始响应文本（已被 maxBytes 截断） */
  text: string
  contentType: string
  status: number
  /** 是否因 maxBytes 或长度上限被截断 */
  truncated: boolean
  finalUrl: string
}

/**
 * 抓取文本响应（搜索端点、RSS、网页）。
 * - 只接受 http(s)：file:// 之类的协议在工具层就拒绝，不把本机文件当网页读
 * - 超时 / 网络错误转成中文原因
 */
export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<FetchTextResult> {
  const { proxy, signal, timeoutMs = 15_000, maxBytes = 512_000, headers } = opts
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只支持 http(s) 地址（收到 ${parsed.protocol}）`)
  }
  const fetchFn = proxy ? proxyFetch(proxy) : fetch
  let res: Response
  try {
    res = await fetchFn(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers
      },
      redirect: 'follow',
      signal: composeSignal(signal, timeoutMs)
    })
  } catch (error) {
    throw new Error(`${describeFetchError(error)}（${parsed.host}）`)
  }
  if (!res.ok) throw new Error(`请求失败: HTTP ${res.status}（${parsed.host}）`)

  const reader = res.body?.getReader()
  let text = ''
  let truncated = false
  if (reader) {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        text += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (bytes - maxBytes))), {
          stream: false
        })
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } else {
    text = await res.text()
  }
  return {
    text,
    contentType: res.headers.get('content-type') ?? '',
    status: res.status,
    truncated,
    finalUrl: res.url || url
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×',
  deg: '°',
  copy: '©',
  reg: '®'
}

/** HTML 实体解码（命名实体 + 十进制/十六进制数字实体） */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * HTML → 可读文本：去掉脚本/样式/注释，块级标签转换行，压缩空白。
 * 目标是给模型读正文，不做完整 DOM 解析（不引入额外依赖）。
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|header|footer|nav)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n· ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从 HTML 里取 <title>（有的页面 title 为空，返回空串而不是占位） */
export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)
  return match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
}
