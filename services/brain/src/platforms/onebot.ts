import type { PlatformMedia, PlatformStatus } from '@pi-amadeus/shared'
import WebSocket from 'ws'
import {
  configString,
  splitMessage,
  type AdapterContext,
  type PlatformAdapter,
  type SendOptions
} from './types.ts'

interface OneBotEvent {
  post_type?: string
  message_type?: string
  self_id?: number
  user_id?: number
  group_id?: number
  message_id?: number
  raw_message?: string
  message?: Array<{
    type?: string
    data?: {
      text?: string
      id?: string | number
      url?: string
      file?: string
      name?: string
      file_name?: string
    }
  }>
  echo?: string
  status?: string
  retcode?: number
  wording?: string
  data?: {
    message?: Array<{ type?: string; data?: { text?: string } }>
  }
}

/**
 * OneBot v11 适配器（NapCat / Lagrange 等 QQ 协议端的通用接口）：
 * 正向 WebSocket 连接，收 message 事件、发 send_private_msg / send_group_msg。
 * 断线自动重连；access_token 通过查询参数传递（OneBot 标准做法）。
 */
export class OneBotAdapter implements PlatformAdapter {
  private ws: WebSocket | null = null
  private state: PlatformStatus = { state: 'stopped' }
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private echoSeq = 0
  private pending = new Map<
    string,
    { resolve: (value: OneBotEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly ctx: AdapterContext
  private readonly url: string
  private readonly accessToken: string

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.url = configString(ctx.config, 'url').replace(/\/+$/, '')
    this.accessToken = configString(ctx.config, 'accessToken')
  }

  async start(): Promise<void> {
    if (!this.url) throw new Error('缺少 OneBot WebSocket 地址')
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectPending(new Error('OneBot 连接已关闭'))
    this.ws?.close()
    this.ws = null
    this.state = { state: 'stopped' }
  }

  status(): PlatformStatus {
    return this.state
  }

  async send(
    chatId: string,
    chatType: 'private' | 'group',
    text: string,
    options?: SendOptions
  ): Promise<void> {
    const replyId = options?.replyTo ? Number(options.replyTo) : NaN
    for (const part of splitMessage(text, 4000)) {
      const message = Number.isFinite(replyId)
        ? [
            { type: 'reply', data: { id: replyId } },
            { type: 'text', data: { text: part } }
          ]
        : part
      if (chatType === 'group') {
        await this.action('send_group_msg', { group_id: Number(chatId), message })
      } else {
        await this.action('send_private_msg', { user_id: Number(chatId), message })
      }
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const target = this.accessToken
        ? `${this.url}${this.url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.accessToken)}`
        : this.url
      const ws = new WebSocket(target)
      this.ws = ws
      let opened = false
      ws.on('open', () => {
        opened = true
        this.state = { state: 'running', detail: this.url, since: Date.now() }
        resolve()
      })
      ws.on('message', (data) => this.onData(String(data)))
      ws.on('error', (error) => {
        this.state = { state: 'error', detail: error.message, since: Date.now() }
        if (!opened) reject(error)
      })
      ws.on('close', () => {
        this.ws = null
        this.rejectPending(new Error('OneBot 连接已关闭'))
        if (this.stopped) return
        this.state = { state: 'error', detail: '连接已断开，正在重连', since: Date.now() }
        this.scheduleReconnect()
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      // 失败时 close/error 会再次触发重连；这里只吞掉未处理的 rejection
      void this.connect().catch(() => {})
    }, 3000)
    this.reconnectTimer.unref()
  }

  private onData(raw: string): void {
    let event: OneBotEvent
    try {
      event = JSON.parse(raw) as OneBotEvent
    } catch {
      return
    }
    if (typeof event.echo === 'string') {
      const pending = this.pending.get(event.echo)
      if (pending) {
        this.pending.delete(event.echo)
        clearTimeout(pending.timer)
        pending.resolve(event)
      }
      return
    }
    if (event.post_type !== 'message') return
    if (event.message_type !== 'private' && event.message_type !== 'group') return
    if (event.user_id !== undefined && event.self_id !== undefined && event.user_id === event.self_id) {
      return
    }
    const text =
      event.message
        ?.filter((segment) => segment.type === 'text')
        .map((segment) => segment.data?.text ?? '')
        .join('') ??
      event.raw_message ??
      ''
    const hasMedia = (event.message ?? []).some((segment) =>
      ['image', 'record', 'file', 'video'].includes(segment.type ?? '')
    )
    if (!text.trim() && !hasMedia) return
    void this.handleMessage(event, text)
  }

  /** 文本 + 图片/语音/文件 + 引用（reply 段会反查原消息取正文） */
  private async handleMessage(event: OneBotEvent, text: string): Promise<void> {
    const isGroup = event.message_type === 'group' && event.group_id !== undefined
    const media: PlatformMedia[] = []
    let quote: string | undefined
    let replyTo: string | undefined

    for (const segment of event.message ?? []) {
      if (segment.type === 'reply' && segment.data?.id !== undefined) {
        replyTo = String(segment.data.id)
        try {
          const target = await this.action('get_msg', { message_id: Number(segment.data.id) })
          quote = target.data?.message
            ?.filter((item) => item.type === 'text')
            .map((item) => item.data?.text ?? '')
            .join('')
            .trim()
        } catch {
          /* 原消息取不到就不带引用文本，回复仍用 reply 段 */
        }
        continue
      }
      if (!['image', 'record', 'file', 'video'].includes(segment.type ?? '')) continue
      const raw = segment.data?.url ?? segment.data?.file ?? ''
      if (!raw) continue
      try {
        let buffer: Buffer
        if (raw.startsWith('base64://')) {
          buffer = Buffer.from(raw.slice('base64://'.length), 'base64')
        } else if (/^https?:\/\//i.test(raw)) {
          const res = await fetch(raw, { signal: AbortSignal.timeout(30_000) })
          if (!res.ok) continue
          buffer = Buffer.from(await res.arrayBuffer())
        } else {
          continue
        }
        if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) continue
        const kind =
          segment.type === 'image' ? 'image' : segment.type === 'record' ? 'audio' : 'file'
        media.push({
          kind,
          name:
            segment.data?.name ||
            segment.data?.file_name ||
            (kind === 'image' ? 'image.jpg' : kind === 'audio' ? 'voice.silk' : 'file'),
          mimeType: kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/silk' : 'application/octet-stream',
          data: buffer.toString('base64'),
          size: buffer.length
        })
      } catch (error) {
        console.warn('[onebot] 附件下载失败：', error instanceof Error ? error.message : error)
      }
    }

    this.ctx.onMessage({
      externalUserId: String(event.user_id ?? ''),
      chatId: String(isGroup ? event.group_id : event.user_id),
      chatType: isGroup ? 'group' : 'private',
      text,
      messageId: event.message_id !== undefined ? String(event.message_id) : replyTo,
      quote,
      media
    })
  }

  private action(action: string, params: Record<string, unknown>): Promise<OneBotEvent> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OneBot 未连接'))
    }
    const echo = String(++this.echoSeq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot ${action} 超时`))
      }, 10_000)
      this.pending.set(echo, { resolve, reject, timer })
      ws.send(JSON.stringify({ action, params, echo }))
    }).then((event) => {
      const result = event as OneBotEvent
      if (result.status === 'failed' || (result.retcode !== undefined && result.retcode !== 0)) {
        throw new Error(result.wording || `OneBot ${action} 失败`)
      }
      return result
    })
  }

  private rejectPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(echo)
    }
  }
}
