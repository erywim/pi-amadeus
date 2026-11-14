/**
 * 消息附件（图片 / 语音 / 文件）：
 * 文件本体保存在大脑的数据目录，消息只带元数据与可访问 URL。
 * 输入用 base64 payload，落库前由服务端校验大小与类型。
 */

export type AttachmentKind = 'image' | 'audio' | 'file'

export interface MessageAttachment {
  id: string
  kind: AttachmentKind
  name: string
  mimeType: string
  size: number
  /** 服务端媒体地址（/api/media/<id>）；本地乐观消息可能是 data: URL */
  url: string
}

export interface AttachmentPayload {
  name: string
  mimeType: string
  /** base64（不含 data: 前缀） */
  data: string
}

export const ATTACHMENT_LIMITS = {
  /** 单条消息最多附件数 */
  count: 6,
  /** 单张图片 */
  imageBytes: 10 * 1024 * 1024,
  /** 单个语音 */
  audioBytes: 25 * 1024 * 1024,
  /** 单个文件 */
  fileBytes: 20 * 1024 * 1024,
  /** 注入模型的单文件文本上限（字符） */
  extractedChars: 20_000,
  /** 注入模型的全部附件文本上限（字符） */
  extractedTotalChars: 40_000
} as const
