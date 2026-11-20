import { Agent, fetch as undiciFetch } from 'undici'
import { proxyFetch } from '../http/proxy.ts'
import { assertPublicHttpUrl, resolvePublicUrl, withAbort } from './publicUrl.ts'

/** 工具 HTTP 客户端：可信搜索端点保留代理能力，任意网页使用 publicOnly 的逐跳校验与 DNS 绑定。 */
export interface FetchJsonOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  proxy?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
}

/** 浏览器 UA：搜索端点与常见站点会拒绝无 UA 的请求或返回移动版页面 */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 连同 body 读取失败保留底层 code/cause；不能只报告没有处置信息的 fetch failed。 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const item = current as { name?: string; code?: string; message?: string; cause?: unknown }
    const code = item.code ?? ''
    const label = item.name === 'TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code)
      ? '连接超时'
      : ['ENOTFOUND', 'EAI_AGAIN'].includes(code) ? '域名解析失败'
        : code === 'ECONNREFUSED' ? '连接被拒绝'
          : code === 'ECONNRESET' ? '连接被重置'
            : ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? '证书校验失败' : ''
    if (label) parts.push(label)
    if (code) parts.push(code)
    if (item.message) parts.push(item.message)
    current = item.cause
  }
  if (current && typeof current !== 'object') parts.push(String(current))
  return [...new Set(parts)].join('；') || String(error)
}

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
}

function fetchError(error: unknown, url: URL, signal: AbortSignal): never {
  // 从传输错误转为取消时优先保留调用方原 reason，避免用户停止被误报为网络故障。
  signal.throwIfAborted()
  throw new Error(`${describeFetchError(error)}（${url.host}）`, { cause: error })
}

function byteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes 必须是正整数字节数')
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

/** 只累积上限以内的字节，多读一块以区分「刚好上限」与「确实截断」。 */
async function readBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(), truncated: false }
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal)
      signal.throwIfAborted()
      if (done) break
      const remaining = maxBytes - size
      if (value.byteLength > remaining) {
        if (remaining) chunks.push(value.slice(0, remaining))
        size += remaining
        // 超出上限后从读取转为取消，不能继续下载大文件，也不把半截伪装为全文。
        truncated = true
        break
      }
      if (value.byteLength) chunks.push(value)
      size += value.byteLength
    }
  } finally {
    // 完成/失败/取消均释放流；cancel 的次生错误不能覆盖原始 body error 或 abort reason。
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

function charsetOf(value: string): string | undefined {
  return /\bcharset\s*=\s*["']?\s*([^\s;"'/>]+)/i.exec(value)?.[1]
}

/** BOM > HTTP charset > HTML meta charset > UTF-8；二进制字符检查在解码之后做，允许 UTF-16。 */
function decodeText(bytes: Uint8Array, contentType: string, truncated: boolean): string {
  let charset: string | undefined
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = 'utf-8'
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = 'utf-16be'
  charset ??= charsetOf(contentType)
  if (!charset && (isHtmlResponse(contentType) || !contentType || contentType.startsWith('text/'))) {
    const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024))
    for (const meta of head.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<meta\b[^>]*>/gi)) {
      charset = charsetOf(meta[0])
      if (charset) break
    }
  }
  try {
    const decoder = new TextDecoder(charset ?? 'utf-8', { fatal: false })
    // 字节截断时不 flush 半个多字节字符，避免尾部被补成 U+FFFD 乱码。
    return decoder.decode(bytes, { stream: truncated })
  } catch (cause) {
    throw new Error(`不支持的响应字符编码：${charset}`, { cause })
  }
}

export function isHtmlResponse(contentType: string, text = ''): boolean {
  return /\b(?:html|xhtml)\b/i.test(contentType) || /^\s*<(?:!doctype\s+html|html|head|meta|title|body)\b/i.test(text)
}

function isTextContentType(contentType: string): boolean {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!mime) return true
  return mime.startsWith('text/') || /^application\/(?:json|xml|xhtml\+xml|javascript|x-javascript|ecmascript|x-ndjson|jsonlines|graphql|sql|toml|yaml|x-yaml|x-www-form-urlencoded)$/.test(mime) ||
    /^application\/[\w.-]+\+(?:json|xml)$/.test(mime)
}

function looksBinary(bytes: Uint8Array, text: string): boolean {
  // 常见二进制魔数即使谎报 text/plain 也不能当正文读；其余类型再看解码后的控制字符。
  const magic = Buffer.from(bytes.subarray(0, 8)).toString('hex')
  if (['255044462d', '504b0304', '504b0506', '504b0708', '89504e47', '47494638', '1f8b', '7f454c46', '52617221', '377abcaf', 'ffd8ff'].some((prefix) => magic.startsWith(prefix))) return true
  const sample = text.slice(0, 4096)
  let controls = 0
  let replacements = 0
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0) return true
    if (code < 9 || (code > 13 && code < 32) || code === 127) controls += 1
    if (code === 0xfffd) replacements += 1
  }
  return controls > sample.length * 0.05 || replacements > sample.length * 0.1
}

export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { method = 'GET', body, proxy, signal, timeoutMs = 15_000, maxBytes = 2_000_000, headers } = opts
  const parsed = new URL(url)
  byteLimit(maxBytes)
  const combined = composeSignal(signal, timeoutMs)
  try {
    combined.throwIfAborted()
    const fetchFn = proxy ? proxyFetch(proxy) : fetch
    const response = await fetchFn(url, {
      method,
      headers: {
        'User-Agent': BROWSER_UA,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: combined
    })
    if (!response.ok) {
      await cancelBody(response)
      throw new Error(`请求失败: HTTP ${response.status}`)
    }
    const result = await readBytes(response, maxBytes, combined)
    if (result.truncated) throw new Error(`JSON 响应过大（超过 ${maxBytes} 字节），拒绝解析截断内容`)
    return JSON.parse(decodeText(result.bytes, response.headers.get('content-type') ?? '', false)) as unknown
  } catch (error) {
    fetchError(error, parsed, combined)
  }
}

export interface FetchTextOptions {
  proxy?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** 最多保留的响应字节数（超出即取消流）。 */
  maxBytes?: number
  headers?: Record<string, string>
  /** 不可信网页必须启用；可信的用户配置搜索引擎端点不启用。 */
  publicOnly?: boolean
}

export interface FetchTextResult {
  text: string
  contentType: string
  status: number
  truncated: boolean
  finalUrl: string
}

/** 抓取有界文本，整个 DNS/重定向/body 共用超时与外层 signal。 */
export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<FetchTextResult> {
  const { proxy, signal, timeoutMs = 15_000, maxBytes = 512_000, publicOnly = false } = opts
  let current = new URL(url)
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    throw new Error(`只支持 http(s) 地址（收到 ${current.protocol}）`)
  }
  byteLimit(maxBytes)
  const combined = composeSignal(signal, timeoutMs)
  let headers = {
    'User-Agent': BROWSER_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...opts.headers
  }
  try {
    combined.throwIfAborted()
    if (publicOnly && proxy) {
      // 现有 ProxyAgent 在代理侧解析目标域名，客户端 lookup 无法固定目标 IP，必须拒绝而非静默绕过代理。
      throw new Error('公网网页读取暂不支持代理：无法固定代理侧的目标 DNS。可将 SEARCH_PROXY= 设为空后直连，或改用可信外部抓取服务；不会自动绕过代理')
    }
    const fetchFn = proxy ? proxyFetch(proxy) : fetch
    for (let hop = 0; ; hop += 1) {
      let agent: Agent | undefined
      try {
        if (publicOnly) {
          current = assertPublicHttpUrl(current.href)
          const lookup = await resolvePublicUrl(current, combined)
          combined.throwIfAborted()
          // 每跳创建仅持有已校验 DNS 快照的连接池，保留原 hostname 以正确校验 TLS/SNI/Host。
          agent = new Agent({ connect: { lookup } })
        }
        const init = { headers, redirect: publicOnly ? 'manual' as const : 'follow' as const, signal: combined }
        const response = agent
          ? await undiciFetch(current.href, { ...init, dispatcher: agent }) as unknown as Response
          : await fetchFn(current.href, init)
        if (publicOnly && [301, 302, 303, 307, 308].includes(response.status)) {
          await cancelBody(response)
          if (hop >= 5) throw new Error('网页重定向次数过多（上限 5 次）')
          const location = response.headers.get('location')
          if (!location) throw new Error('网页重定向缺少 Location 地址')
          const next = new URL(location, current)
          if (next.origin !== current.origin) {
            headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(authorization|proxy-authorization|cookie|cookie2|host)$/i.test(key))) as typeof headers
          }
          // 从当前响应转入下一跳前，下一轮必须重新校验 URL 和全部 DNS，不信任 Location。
          current = next
          continue
        }
        if (!response.ok) {
          await cancelBody(response)
          throw new Error(`请求失败: HTTP ${response.status}`)
        }
        const contentType = response.headers.get('content-type') ?? ''
        if (!isTextContentType(contentType)) {
          await cancelBody(response)
          throw new Error(`不支持的二进制内容类型：${contentType}`)
        }
        const result = await readBytes(response, maxBytes, combined)
        const text = decodeText(result.bytes, contentType, result.truncated)
        if (looksBinary(result.bytes, text)) throw new Error(`响应是二进制或无效文本，未解析内容（${contentType || '未知内容类型'}）`)
        return {
          text,
          contentType,
          status: response.status,
          truncated: result.truncated,
          finalUrl: publicOnly ? current.href : response.url || current.href
        }
      } finally {
        // 完成/失败/重定向都销毁本跳连接池，不能复用旧的解析快照或留下活动 socket。
        await agent?.destroy().catch(() => {})
      }
    }
  } catch (error) {
    fetchError(error, current, combined)
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

/** HTML 实体解码；非法/越界数值保持原文，不能让一个实体使整页读取失败。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = /^#x/i.test(body)
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** HTML → 可读文本：去脚本/样式/注释，块级标签转换行，压缩空白。 */
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
    .replace(/[ \t\f\v\xA0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从 HTML 里取 <title>（有的页面 title 为空，返回空串而不是占位）。 */
export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)
  return match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
}
