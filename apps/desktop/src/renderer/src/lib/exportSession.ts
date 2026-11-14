import type { Message, Session } from '@pi-amadeus/shared'
import { fetchMessages } from './api'

export interface ExportLabels {
  user: string
  assistant: string
  attachments: string
  untitled: string
}

const ATTACHMENT_KIND_LABEL: Record<string, string> = {
  image: 'image',
  audio: 'audio',
  file: 'file'
}

function stamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 会话 → Markdown。只使用已经落库的真实消息，不补写任何内容。 */
export function buildSessionMarkdown(
  session: Pick<Session, 'id' | 'title' | 'channel' | 'createdAt'>,
  messages: Message[],
  labels: ExportLabels
): string {
  const lines: string[] = []
  lines.push(`# ${session.title || labels.untitled}`)
  lines.push('')
  lines.push(`- Session: \`${session.id}\``)
  lines.push(`- Channel: \`${session.channel}\``)
  lines.push(`- Created: ${stamp(session.createdAt)}`)
  lines.push(`- Exported: ${stamp(Date.now())}`)
  lines.push(`- Messages: ${messages.length}`)
  lines.push('')
  lines.push('---')
  for (const message of messages) {
    lines.push('')
    lines.push(`## ${message.role === 'user' ? labels.user : labels.assistant} · ${stamp(message.createdAt)}`)
    lines.push('')
    lines.push(message.content || '')
    const attachments = message.attachments ?? []
    if (attachments.length > 0) {
      lines.push('')
      lines.push(`**${labels.attachments}**`)
      for (const attachment of attachments) {
        const kind = ATTACHMENT_KIND_LABEL[attachment.kind] ?? attachment.kind
        lines.push(`- \`${attachment.name}\` (${kind}, ${Math.max(1, Math.round(attachment.size / 1024))} KB)`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

function safeFilename(title: string, sessionId: string): string {
  const base = (title.trim() || sessionId).replace(/[\\/:*?"<>|\n\r\t]+/g, '-').slice(0, 60)
  return `amadeus-${base}.md`
}

/** 从服务端取最新消息（不依赖界面是否加载过），生成并下载 Markdown */
export async function exportSessionMarkdown(
  session: Pick<Session, 'id' | 'title' | 'channel' | 'createdAt'>,
  labels: ExportLabels
): Promise<string> {
  const { messages } = await fetchMessages(session.id)
  const content = buildSessionMarkdown(session, messages, labels)
  const filename = safeFilename(session.title, session.id)
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 下载触发后再回收 URL：立即 revoke 在部分 Chromium 版本会取消下载
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  return filename
}
