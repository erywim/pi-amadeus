import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { fetchText, htmlTitle, htmlToText, isHtmlResponse } from './net.ts'

// 兼容已有导入；同步检查只检查字面地址，实际抓取的完整校验由 fetchText(publicOnly) 执行。
export { assertPublicHttpUrl } from './publicUrl.ts'

export const fetchUrlSchema = Type.Object({
  url: Type.String({ description: '要读取的公网网页地址（http/https）' }),
  maxChars: Type.Optional(
    Type.Integer({ minimum: 500, maximum: 40_000, description: '正文最大字符数，默认 12000' })
  )
})

type FetchUrlArgs = Static<typeof fetchUrlSchema>

export interface PublicPage {
  url: string
  title: string
  contentType: string
  /** 可读正文；截断时包含明确提示，chars 不包含提示。 */
  text: string
  /** 已读取并转换的正文长度；发生字节截断时不是整页总字数。 */
  chars: number
  truncated: boolean
  kind: 'html' | 'json' | 'text' | 'empty'
}

export interface ReadPublicPageOptions {
  proxy?: string
  signal?: AbortSignal
  maxChars?: number
  maxBytes?: number
}

/** 工具、诊断路由与知识库共用入口；二进制/非公网/网络错误均抛出可读原因。 */
export async function readPublicPage(url: string, opts: ReadPublicPageOptions = {}): Promise<PublicPage> {
  const maxChars = opts.maxChars ?? 12_000
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error('maxChars 必须是正整数')
  const result = await fetchText(url.trim(), {
    proxy: opts.proxy,
    signal: opts.signal,
    publicOnly: true,
    timeoutMs: 20_000,
    maxBytes: opts.maxBytes ?? 3_000_000
  })
  const contentType = result.contentType.toLowerCase()
  const isHtml = isHtmlResponse(contentType, result.text)
  const title = isHtml ? htmlTitle(result.text) : ''
  const body = isHtml ? htmlToText(result.text) : result.text.trim()
  const clipped = body.length > maxChars
  const truncated = result.truncated || clipped
  const visible = clipped ? body.slice(0, maxChars) : body
  const marker = result.truncated
    ? '…（正文已截断：达到响应字节上限，未读取整页）'
    : `…（正文已截断，共 ${body.length} 字符）`
  return {
    url: result.finalUrl,
    title,
    contentType,
    text: truncated ? `${visible}\n\n${marker}` : visible,
    chars: body.length,
    truncated,
    kind: !body ? 'empty' : /\bjson\b/.test(contentType) ? 'json' : isHtml ? 'html' : 'text'
  }
}

/** 搜索给摘要；读取工具打开具体网页核对正文，不作为绕过确认的内网探测通道。 */
export function createFetchUrlTool(opts: { proxy?: string; signal?: AbortSignal }): AgentTool<typeof fetchUrlSchema> {
  return {
    name: 'fetch_url',
    label: '读取网页',
    description:
      '读取一个公网网页的正文（HTML 会转成纯文本）。用于在 search 之后打开具体结果核对细节、读文档或新闻原文。',
    parameters: fetchUrlSchema,
    execute: async (_toolCallId, params: FetchUrlArgs) => {
      const page = await readPublicPage(params.url, { ...opts, maxChars: params.maxChars })
      return {
        content: [{
          type: 'text',
          text: page.text
            ? `${page.title ? `# ${page.title}\n\n` : ''}${page.text}`
            : `页面没有可读正文（可能是纯脚本渲染的页面）：${page.url}`
        }],
        details: page
      }
    }
  }
}
