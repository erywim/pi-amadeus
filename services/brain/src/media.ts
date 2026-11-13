import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentPayload,
  type Message,
  type MessageAttachment
} from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'
import type { MessageRow } from './db.ts'
import { transcribe } from './stt.ts'

/**
 * 消息附件落盘：图片 / 语音 / 文件存到大脑数据目录，数据库只存元数据。
 * 文件名用随机 id，原始文件名只作为展示名（防止路径穿越）。
 */

export interface SavedAttachment {
  id: string
  kind: AttachmentKind
  name: string
  mimeType: string
  size: number
  path: string
  /** 文本文件正文 / 语音转写；图片为 null */
  extractedText: string | null
}

const TEXT_MIME = /^text\//i
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.log',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sh',
  '.sql',
  '.toml',
  '.ini'
])

export function classifyAttachment(name: string, mimeType: string): AttachmentKind {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/') || mime.startsWith('video/ogg')) return 'audio'
  if (mime.startsWith('video/')) return 'file'
  if (TEXT_MIME.test(mime)) return 'file'
  const ext = extname(name).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image'
  if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm'].includes(ext)) return 'audio'
  return 'file'
}

function maxBytesOf(kind: AttachmentKind): number {
  if (kind === 'image') return ATTACHMENT_LIMITS.imageBytes
  if (kind === 'audio') return ATTACHMENT_LIMITS.audioBytes
  return ATTACHMENT_LIMITS.fileBytes
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  return base.trim().slice(0, 120) || '未命名附件'
}

function extensionOf(name: string, mimeType: string): string {
  const fromName = extname(name).toLowerCase()
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName
  const fromMime = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (/^[a-z0-9]{1,8}$/.test(fromMime)) return `.${fromMime}`
  return '.bin'
}

/** 文本文件正文注入模型；其它类型返回 null（图片走视觉输入，语音走 STT） */
export function extractText(buffer: Buffer, name: string, mimeType: string): string | null {
  const mime = mimeType.toLowerCase()
  const ext = extname(name).toLowerCase()
  if (!TEXT_MIME.test(mime) && !TEXT_EXTENSIONS.has(ext) && mime !== 'application/json') {
    return null
  }
  const text = buffer.toString('utf8')
  // 粗略二进制判定：NUL 字符说明不是文本
  if (text.includes('\u0000')) return null
  return text.length > ATTACHMENT_LIMITS.extractedChars
    ? `${text.slice(0, ATTACHMENT_LIMITS.extractedChars)}\n…（已截断）`
    : text
}

/** 保存一个 base64 附件；超出类型上限时抛错（由路由转成 400） */
export function saveAttachment(
  payload: AttachmentPayload,
  dir: string,
  opts?: { id?: string; extractedText?: string | null }
): SavedAttachment {
  const name = safeName(payload.name || '附件')
  const mimeType = (payload.mimeType || 'application/octet-stream').toLowerCase()
  const kind = classifyAttachment(name, mimeType)
  const base64 = payload.data.replace(/^data:[^;]+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw new Error('附件内容为空')
  const limit = maxBytesOf(kind)
  if (buffer.length > limit) {
    throw new Error(`附件「${name}」超过 ${Math.round(limit / 1024 / 1024)}MB 上限`)
  }
  const id = opts?.id ?? randomUUID()
  const path = join(dir, `${id}${extensionOf(name, mimeType)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, buffer)
  return {
    id,
    kind,
    name,
    mimeType,
    size: buffer.length,
    path,
    extractedText:
      opts?.extractedText !== undefined ? opts.extractedText : extractText(buffer, name, mimeType)
  }
}

/** 编辑分支独占附件文件与 ID；沿用已保存的文本/语音转写，不重复抽取或 STT。 */
export function copyAttachments(items: SavedAttachment[], dir: string): SavedAttachment[] {
  const copies: SavedAttachment[] = []
  try {
    for (const item of items) {
      const id = randomUUID()
      const path = join(dir, `${id}${extensionOf(item.name, item.mimeType)}`)
      mkdirSync(dir, { recursive: true })
      copyFileSync(item.path, path)
      copies.push({ ...item, id, path })
    }
    return copies
  } catch (error) {
    // 复制中途失败时回滚本轮副本，不能留下半批附件或碰原件
    removeAttachmentCopies(copies)
    throw error
  }
}

/** 仅用于尚未提交的编辑副本；原消息的附件不能经过此清理路径。 */
export function removeAttachmentCopies(items: SavedAttachment[]): void {
  for (const item of items) rmSync(item.path, { force: true })
}

/** 读取已落盘附件（媒体路由用） */
export function readAttachment(path: string): Buffer {
  return readFileSync(path)
}

/** 数据库行 / 落盘结果 → 对外消息附件（不暴露磁盘路径与抽取文本） */
export function toMessageAttachment(row: {
  id: string
  kind: AttachmentKind
  name: string
  mimeType: string
  size: number
}): MessageAttachment {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    url: `/api/media/${row.id}`
  }
}

/** 数据库消息 → 对外的 Message（去掉路径 / 抽取文本等内部字段） */
export function toPublicMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    ttsText: row.ttsText,
    mode: row.mode,
    parentId: row.parentId,
    branchIndex: row.branchIndex,
    branchCount: row.branchCount,
    attachments: row.attachments.map(toMessageAttachment),
    ...(row.changedFiles.length > 0 ? { changedFiles: row.changedFiles } : {}),
    ...(row.thinking ? { thinking: row.thinking } : {}),
    createdAt: row.createdAt
  }
}

/**
 * 保存一批 base64 附件；配置了 Whisper 时顺带转写语音。
 * 返回的 extractedText 会进入本轮 LLM 上下文（图片为 null）。
 */
export async function prepareAttachments(
  cfg: BrainConfig,
  payloads: AttachmentPayload[]
): Promise<SavedAttachment[]> {
  if (payloads.length > ATTACHMENT_LIMITS.count) {
    throw new Error(`一条消息最多 ${ATTACHMENT_LIMITS.count} 个附件`)
  }
  const saved = payloads.map((payload) => saveAttachment(payload, cfg.media.dir))
  if (!cfg.whisper.apiKey || !cfg.whisper.baseUrl) return saved
  for (const item of saved) {
    if (item.kind !== 'audio') continue
    try {
      const transcript = await transcribe(readAttachment(item.path), {
        apiKey: cfg.whisper.apiKey,
        baseUrl: cfg.whisper.baseUrl,
        model: cfg.whisper.model,
        proxy: cfg.whisper.proxy || undefined
      }, { filename: item.name, mimeType: item.mimeType })
      const text = transcript.trim()
      if (text) {
        item.extractedText =
          text.length > ATTACHMENT_LIMITS.extractedChars
            ? `${text.slice(0, ATTACHMENT_LIMITS.extractedChars)}\n…（已截断）`
            : text
      }
    } catch (error) {
      console.warn(
        `[media] 语音转写失败 ${item.name}：`,
        error instanceof Error ? error.message : error
      )
    }
  }
  return saved
}
