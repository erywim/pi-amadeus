import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { fetchText, htmlTitle, htmlToText } from './net.ts'

/**
 * 读取网页正文：把搜索结果的链接变成模型能读的内容。
 *
 * 只有 search 没有 fetch_url 时，模型只能看摘要（每条一两句话），
 * 遇到「打开这个页面确认」就无能为力；这也是常见 agent 的标配组合。
 *
 * 边界：
 * - 只允许 http(s)，本机地址（localhost / 127.x / 私有网段）一律拒绝——
 *   模型可以用 bash 访问本机，但网页抓取不该成为绕过确认的内网探测通道
 * - 正文按字符上限截断，并在结果里明确写出「已截断」，不假装读完了
 * - 二进制内容（图片/压缩包）不解析，明确告知类型
 */

export const fetchUrlSchema = Type.Object({
  url: Type.String({ description: '要读取的网页地址（http/https）' }),
  maxChars: Type.Optional(
    Type.Integer({ minimum: 500, maximum: 40_000, description: '正文最大字符数，默认 12000' })
  )
})

type FetchUrlArgs = Static<typeof fetchUrlSchema>

/** 默认正文上限：足够放下一篇文章，又不至于把上下文挤爆 */
const DEFAULT_MAX_CHARS = 12_000

export function createFetchUrlTool(opts: { proxy?: string; signal?: AbortSignal }): AgentTool<typeof fetchUrlSchema> {
  return {
    name: 'fetch_url',
    label: '读取网页',
    description:
      '读取一个网页的正文（HTML 会转成纯文本）。用于在 search 之后打开具体结果核对细节、读文档或新闻原文。',
    parameters: fetchUrlSchema,
    execute: async (_toolCallId, params: FetchUrlArgs) => {
      const url = params.url.trim()
      assertPublicHttpUrl(url)
      const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS
      const res = await fetchText(url, {
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        timeoutMs: 20_000,
        maxBytes: 3_000_000
      })

      const contentType = res.contentType.toLowerCase()
      if (contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/')) {
        return {
          content: [{ type: 'text', text: `该地址是 ${contentType} 媒体文件，无法解析为文本：${url}` }],
          details: { url, contentType, kind: 'media' }
        }
      }
      if (
        contentType.startsWith('application/pdf') ||
        contentType.startsWith('application/zip') ||
        contentType.startsWith('application/octet-stream')
      ) {
        return {
          content: [{ type: 'text', text: `该地址是二进制文件（${contentType}），未解析内容：${url}` }],
          details: { url, contentType, kind: 'binary' }
        }
      }

      const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(res.text)
      const isJson = contentType.includes('json')
      const title = isHtml ? htmlTitle(res.text) : ''
      const body = isHtml ? htmlToText(res.text) : res.text.trim()
      const clipped = body.length > maxChars
      const text = clipped ? `${body.slice(0, maxChars)}\n\n…（正文已截断，共 ${body.length} 字符）` : body
      if (!text) {
        return {
          content: [{ type: 'text', text: `页面没有可读正文（可能是纯脚本渲染的页面）：${url}` }],
          details: { url, contentType, kind: 'empty' }
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `${title ? `# ${title}\n\n` : ''}${text}`
          }
        ],
        details: {
          url: res.finalUrl,
          contentType,
          chars: body.length,
          truncated: clipped,
          kind: isJson ? 'json' : isHtml ? 'html' : 'text'
        }
      }
    }
  }
}

/** 内网/本机地址判定：抓取工具不得成为内网探测或本地文件读取通道 */
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i

export function assertPublicHttpUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http(s) 地址（收到 ${url.protocol}）`)
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new Error(`拒绝访问本机/内网地址：${url.hostname}`)
  }
}
