import type { PlatformMedia, PlatformStatus } from '@pi-amadeus/shared'
import {
  configString,
  splitMessage,
  type AdapterContext,
  type PlatformAdapter,
  type SendOptions
} from './types.ts'

interface TelegramFileRef {
  file_id: string
  file_size?: number
  mime_type?: string
  file_name?: string
}

interface TelegramMessage {
  message_id?: number
  text?: string
  caption?: string
  chat: { id: number; type: string }
  from?: { id: number; is_bot?: boolean }
  photo?: TelegramFileRef[]
  voice?: TelegramFileRef
  audio?: TelegramFileRef
  document?: TelegramFileRef
  reply_to_message?: { text?: string; caption?: string }
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

/**
 * Telegram Bot 适配器：长轮询 getUpdates（不需要公网地址），sendMessage 回复。
 * 只处理文本消息；图片/语音/文件暂不解析（会在文档里标注）。
 */
export class TelegramAdapter implements PlatformAdapter {
  private controller: AbortController | null = null
  private state: PlatformStatus = { state: 'stopped' }
  private stopped = false
  private detail = ''
  private readonly ctx: AdapterContext
  private readonly token: string
  private readonly baseUrl: string

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.token = configString(ctx.config, 'token')
    this.baseUrl = (configString(ctx.config, 'baseUrl') || 'https://api.telegram.org').replace(/\/+$/, '')
  }

  async start(): Promise<void> {
    if (!this.token) throw new Error('缺少 Bot Token')
    this.stopped = false
    this.controller = new AbortController()
    const me = await this.api<{ username?: string }>('getMe', {}, 15_000)
    this.detail = me.username ? `@${me.username}` : 'Telegram'
    this.state = { state: 'running', detail: this.detail, since: Date.now() }
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    this.state = { state: 'stopped' }
  }

  status(): PlatformStatus {
    return this.state
  }

  async send(
    chatId: string,
    _chatType: 'private' | 'group',
    text: string,
    options?: SendOptions
  ): Promise<void> {
    for (const part of splitMessage(text, 4000)) {
      const replyId = options?.replyTo ? Number(options.replyTo) : NaN
      await this.api('sendMessage', {
        chat_id: chatId,
        text: part,
        ...(Number.isFinite(replyId)
          ? { reply_parameters: { message_id: replyId, allow_sending_without_reply: true } }
          : {})
      })
    }
  }

  private async poll(): Promise<void> {
    let offset = 0
    while (!this.stopped) {
      try {
        const updates = await this.api<TelegramUpdate[]>(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message'] },
          35_000
        )
        // 成功一次就把状态从 error 拉回 running（长轮询超时是正常现象）
        if (this.state.state !== 'running') {
          this.state = { state: 'running', detail: this.detail, since: Date.now() }
        }
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1)
          const message = update.message
          if (!message || message.from?.is_bot) continue
          if (!message.text && !message.caption && !message.photo && !message.voice && !message.audio && !message.document) {
            continue
          }
          void this.handleMessage(message)
        }
      } catch (error) {
        if (this.stopped) return
        this.state = {
          state: 'error',
          detail: error instanceof Error ? error.message : String(error),
          since: Date.now()
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
  }

  /** 文本 + 图片 / 语音 / 文件 + 引用；媒体先下载成 base64 再交给管线 */
  private async handleMessage(message: TelegramMessage): Promise<void> {
    const media: PlatformMedia[] = []
    const add = async (
      ref: TelegramFileRef | undefined,
      name: string,
      fallbackMime: string
    ): Promise<void> => {
      if (!ref?.file_id) return
      if ((ref.file_size ?? 0) > 20 * 1024 * 1024) return
      try {
        const file = await this.api<{ file_path?: string; file_size?: number }>('getFile', {
          file_id: ref.file_id
        })
        if (!file.file_path) return
        const url = `${this.baseUrl}/file/bot${this.token}/${file.file_path}`
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) return
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length > 20 * 1024 * 1024) return
        media.push({
          kind: fallbackMime.startsWith('image/')
            ? 'image'
            : fallbackMime.startsWith('audio/')
              ? 'audio'
              : 'file',
          name: ref.file_name || name,
          mimeType: ref.mime_type || fallbackMime,
          data: buffer.toString('base64'),
          size: buffer.length
        })
      } catch (error) {
        console.warn('[telegram] 附件下载失败：', error instanceof Error ? error.message : error)
      }
    }

    if (message.photo?.length) {
      await add(message.photo[message.photo.length - 1], 'photo.jpg', 'image/jpeg')
    }
    if (message.voice) await add(message.voice, 'voice.ogg', message.voice.mime_type || 'audio/ogg')
    if (message.audio) await add(message.audio, 'audio.mp3', message.audio.mime_type || 'audio/mpeg')
    if (message.document) {
      await add(
        message.document,
        message.document.file_name || 'file',
        message.document.mime_type || 'application/octet-stream'
      )
    }

    this.ctx.onMessage({
      externalUserId: String(message.from?.id ?? message.chat.id),
      chatId: String(message.chat.id),
      chatType: message.chat.type === 'private' ? 'private' : 'group',
      text: message.text ?? message.caption ?? '',
      messageId: message.message_id ? String(message.message_id) : undefined,
      quote: message.reply_to_message?.text ?? message.reply_to_message?.caption,
      media
    })
  }

  private async api<T>(method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (this.controller) signals.push(this.controller.signal)
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.any(signals)
    })
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: T; description?: string }
      | null
    if (!res.ok || !json?.ok) {
      throw new Error(json?.description || `Telegram HTTP ${res.status}`)
    }
    return json.result as T
  }
}
