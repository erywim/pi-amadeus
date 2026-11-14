import type { Message } from '@pi-amadeus/shared'

/**
 * 工作台的纯数据助手：
 * 会话泳道颜色、可预览工件提取。全部只读真实消息，不生成任何内容。
 */

/**
 * 稳定的空消息数组：zustand v5 的 selector 如果每次返回新的 `[]`，
 * useSyncExternalStore 会认为快照一直在变，触发无限重渲染。
 */
export const EMPTY_MESSAGES: Message[] = []

const LANE_COLORS = [
  'var(--lane-1)',
  'var(--lane-2)',
  'var(--lane-3)',
  'var(--lane-4)',
  'var(--lane-5)',
  'var(--lane-6)'
]

/** 按会话 id 稳定取色：排序变化时颜色不跳 */
export function laneColorFor(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return LANE_COLORS[hash % LANE_COLORS.length]!
}

export interface SessionArtifact {
  id: string
  messageId: string
  lang: string
  code: string
  title: string
}

/** 可预览语言：与 Markdown 代码块上的「预览」入口保持一致 */
const PREVIEWABLE = new Set(['html', 'svg', 'mermaid'])

/** 从助手消息里提取 HTML / SVG / Mermaid 代码块（真实消息内容） */
export function artifactsOf(messages: Message[]): SessionArtifact[] {
  const artifacts: SessionArtifact[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const regex = /```([a-zA-Z0-9_-]+)\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    let index = 0
    while ((match = regex.exec(message.content)) !== null) {
      const lang = (match[1] ?? '').toLowerCase()
      if (!PREVIEWABLE.has(lang)) continue
      const code = (match[2] ?? '').trim()
      if (!code) continue
      const firstLine = (code.split('\n').find((line) => line.trim().length > 0) ?? '').trim()
      // HTML/SVG 的第一行通常是 <!DOCTYPE>/<svg>，优先取文档自带的 <title>；
      // 都没有时用语言名，避免列表里出现「HTML <!DOCTYPE html>」这种标题
      const documentTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code)?.[1]?.trim() ?? ''
      const title =
        documentTitle ||
        (firstLine && !firstLine.startsWith('<') ? firstLine.slice(0, 48) : `${lang.toUpperCase()} 工件`)
      artifacts.push({
        id: `${message.id}-${index}`,
        messageId: message.id,
        lang,
        code,
        title
      })
      index += 1
    }
  }
  return artifacts
}

/** 工具参数的一行摘要（终端视图用） */
export function summarizeArgs(args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return `$ ${args.command}`
  try {
    const text = JSON.stringify(args)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return ''
  }
}

/** 结果摘要：最多保留 6 行 / 420 字，避免终端被长输出淹没 */
export function summarizeResult(text: string | undefined, limit = 420): string {
  if (!text) return ''
  const trimmed = text.trim()
  if (!trimmed) return ''
  const lines = trimmed.split('\n').slice(0, 6).join('\n')
  return lines.length > limit ? `${lines.slice(0, limit)}…` : lines
}
