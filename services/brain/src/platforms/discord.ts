import type { PlatformMedia, PlatformStatus } from '@pi-amadeus/shared'
import WebSocket from 'ws'
import {
  configString,
  splitMessage,
  type AdapterContext,
  type PlatformAdapter,
  type SendOptions
} from './types.ts'

/** Discord 单条消息上限（普通用户 2000 字符；按 1900 分段留余量） */
const DISCORD_LIMIT = 1900
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
const INTENTS = 1 | 512 | 4096 | 32768

interface DiscordPayload {
  op: number
  t?: string
  s?: number
  d?: Record<string, unknown>
}

interface DiscordAttachment {
  url?: string
  content_type?: string
  filename?: string
  size?: number
}

interface DiscordMessage {
  id?: string
  channel_id?: string
  guild_id?: string | null
  content?: string
  author?: { id?: string; username?: string; bot?: boolean }
  attachments?: DiscordAttachment[]
  referenced_message?: { content?: string }
}

/**
 * Discord 机器人适配器：Gateway WebSocket 接收（v10）+ REST 发送。
 * 处理文本与附件消息；忽略其它机器人（含自己）的消息，避免回声。
 * 断线自动重连（Discord 的 op 7 / 连接关闭都走同一条重连路径）。
 */
export class DiscordAdapter implements PlatformAdapter {
  private ws: WebSocket | null = null
  private state: PlatformStatus = { state: 'stopped' }
  private stopped = false
  private heartbeat: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private seq: number | null = null
  private selfId = ''
  private botName = ''
  private readonly ctx: AdapterContext
  private readonly token: string
  private readonly gatewayUrl: string
  private readonly apiBaseUrl: string

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.token = configString(ctx.config, 'botToken')
    this.gatewayUrl =
      configString(ctx.config, 'gatewayUrl') || 'wss://gateway.discord.gg/?v=10&encoding=json'
    this.apiBaseUrl = (configString(ctx.config, 'apiBaseUrl') || 'https://discord.com/api/v10').replace(
      /\/+$/,
      ''
    )
  }

  async start(): Promise<void> {
    if (!this.token) throw new Error('缺少 Bot Token')
    this.stopped = false
    // 先验证 token（也顺便拿到 bot 用户名）；失败时不要静默起一个永远连不上的 WS
    const me = await this.api<{ id?: string; username?: string }>('/users/@me', 'GET')
    this.selfId = me.id ?? ''
    this.botName = me.username ?? ''
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
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
    for (const part of splitMessage(text, DISCORD_LIMIT)) {
      await this.api(`/channels/${encodeURIComponent(chatId)}/messages`, 'POST', {
        content: part,
        // 不要让模型输出里的 @everyone/@here 真的 ping 全群
        allowed_mentions: { parse: [] },
        ...(options?.replyTo ? { message_reference: { message_id: options.replyTo } } : {})
      })
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.gatewayUrl)
      this.ws = ws
      let opened = false
      let identified = false

      ws.on('open', () => {
        opened = true
      })
      ws.on('message', (data) => {
        let payload: DiscordPayload
        try {
          payload = JSON.parse(String(data)) as DiscordPayload
        } catch {
          return
        }
        if (typeof payload.s === 'number') this.seq = payload.s
        switch (payload.op) {
          case 10: {
            const interval = Number((payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250)
            this.startHeartbeat(interval)
            this.identify()
            identified = true
            this.state = {
              state: 'running',
              detail: this.botName ? `@${this.botName}` : 'Discord',
              since: Date.now()
            }
            resolve()
            return
          }
          case 11: // HEARTBEAT_ACK
            return
          case 1: // 服务端要求立刻心跳
            this.sendHeartbeat()
            return
          case 7: // RECONNECT
            this.reconnect()
            return
          case 9: // INVALID_SESSION
            this.reconnect()
            return
          case 0:
            this.onDispatch(payload)
            return
          default:
            return
        }
      })
      ws.on('error', (error) => {
        this.state = { state: 'error', detail: error.message, since: Date.now() }
        if (!opened) reject(error)
      })
      ws.on('close', () => {
        this.ws = null
        if (this.heartbeat) clearInterval(this.heartbeat)
        this.heartbeat = null
        if (this.stopped) return
        if (!identified) {
          // 握手都没完成就断了：交给上层报错，别无限重连掩盖配置错误
          this.state = { state: 'error', detail: 'Gateway 握手失败', since: Date.now() }
          reject(new Error('Discord Gateway 握手失败'))
          return
        }
        this.state = { state: 'error', detail: '连接已断开，正在重连', since: Date.now() }
        this.scheduleReconnect()
      })
    })
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => this.sendHeartbeat(), Math.max(5_000, intervalMs))
    this.heartbeat.unref()
    this.sendHeartbeat()
  }

  private sendHeartbeat(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ op: 1, d: this.seq }))
  }

  private identify(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          intents: INTENTS,
          properties: { os: process.platform, browser: 'amadeus', device: 'amadeus' }
        }
      })
    )
  }

  private onDispatch(payload: DiscordPayload): void {
    if (payload.t === 'READY') {
      const user = (payload.d as { user?: { id?: string; username?: string } })?.user
      if (user?.id) this.selfId = user.id
      if (user?.username) this.botName = user.username
      return
    }
    if (payload.t !== 'MESSAGE_CREATE') return
    const message = payload.d as DiscordMessage | undefined
    if (!message?.channel_id) return
    if (!message.content?.trim() && (message.attachments?.length ?? 0) === 0) return
    if (message.author?.bot) return
    if (message.author?.id && message.author.id === this.selfId) return
    void this.handleMessage(message)
  }

  /** 文本 + 附件 + 引用；Discord CDN 附件直接下载 */
  private async handleMessage(message: DiscordMessage): Promise<void> {
    const media: PlatformMedia[] = []
    for (const attachment of message.attachments ?? []) {
      if (!attachment.url || (attachment.size ?? 0) > 20 * 1024 * 1024) continue
      try {
        const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) continue
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length > 20 * 1024 * 1024) continue
        const mimeType = attachment.content_type || 'application/octet-stream'
        media.push({
          kind: mimeType.startsWith('image/')
            ? 'image'
            : mimeType.startsWith('audio/')
              ? 'audio'
              : 'file',
          name: attachment.filename || 'attachment',
          mimeType,
          data: buffer.toString('base64'),
          size: buffer.length
        })
      } catch (error) {
        console.warn('[discord] 附件下载失败：', error instanceof Error ? error.message : error)
      }
    }
    this.ctx.onMessage({
      externalUserId: String(message.author?.id ?? ''),
      chatId: String(message.channel_id),
      chatType: message.guild_id ? 'group' : 'private',
      text: message.content ?? '',
      messageId: message.id,
      quote: message.referenced_message?.content,
      media
    })
  }

  private reconnect(): void {
    if (this.stopped) return
    this.ws?.close()
    this.ws = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.connect().catch(() => {})
    }, 3_000)
    this.reconnectTimer.unref()
  }

  private async api<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Discord HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`)
    }
    return (await res.json().catch(() => ({}))) as T
  }
}
