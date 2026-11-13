import type { PlatformStatus } from '@pi-amadeus/shared'
import WebSocket from 'ws'
import { configString, splitMessage, type AdapterContext, type PlatformAdapter } from './types.ts'

interface OneBotEvent {
  post_type?: string
  message_type?: string
  self_id?: number
  user_id?: number
  group_id?: number
  raw_message?: string
  message?: Array<{ type?: string; data?: { text?: string } }>
  echo?: string
  status?: string
  retcode?: number
  wording?: string
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

  async send(chatId: string, chatType: 'private' | 'group', text: string): Promise<void> {
    for (const part of splitMessage(text, 4000)) {
      if (chatType === 'group') {
        await this.action('send_group_msg', { group_id: Number(chatId), message: part })
      } else {
        await this.action('send_private_msg', { user_id: Number(chatId), message: part })
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
    if (!text.trim()) return
    const isGroup = event.message_type === 'group' && event.group_id !== undefined
    this.ctx.onMessage({
      externalUserId: String(event.user_id ?? ''),
      chatId: String(isGroup ? event.group_id : event.user_id),
      chatType: isGroup ? 'group' : 'private',
      text
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
