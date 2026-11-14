import type { PlatformMedia, PlatformStatus } from '@pi-amadeus/shared'
import WebSocket from 'ws'
import {
  configString,
  splitMessage,
  type AdapterContext,
  type PlatformAdapter,
  type SendOptions
} from './types.ts'

/** QQ 官方机器人单条文本上限约 2000 字，按 1800 分段 */
const QQBOT_LIMIT = 1800
/** GROUP_AND_C2C_EVENT（群 / 私聊 @ 消息） */
const INTENTS = 1 << 25

interface QqPayload {
  op: number
  t?: string
  s?: number
  d?: Record<string, unknown>
}

interface QqAttachment {
  url?: string
  content_type?: string
  filename?: string
  size?: number
}

interface QqMessage {
  id?: string
  content?: string
  group_openid?: string
  author?: { user_openid?: string; member_openid?: string }
  attachments?: QqAttachment[]
}

/**
 * QQ 官方机器人适配器（WebSocket 网关 + REST 发送）：
 * - AppID + AppSecret 换 access_token；token 过期自动刷新
 * - 监听 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE
 * - 回复带 msg_id 走被动消息（引用原消息）
 */
export class QqBotAdapter implements PlatformAdapter {
  private ws: WebSocket | null = null
  private state: PlatformStatus = { state: 'stopped' }
  private stopped = false
  private heartbeat: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private seq: number | null = null
  private accessTokenValue = ''
  private accessTokenExpiresAt = 0
  private readonly ctx: AdapterContext
  private readonly appId: string
  private readonly clientSecret: string
  private readonly tokenUrl: string
  private readonly apiBaseUrl: string
  private readonly gatewayUrlOverride: string

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.appId = configString(ctx.config, 'appId')
    this.clientSecret = configString(ctx.config, 'clientSecret')
    this.tokenUrl = configString(ctx.config, 'tokenUrl') || 'https://bots.qq.com/app/getAppAccessToken'
    this.apiBaseUrl = (configString(ctx.config, 'apiBaseUrl') || 'https://api.sgroup.qq.com').replace(
      /\/+$/,
      ''
    )
    this.gatewayUrlOverride = configString(ctx.config, 'gatewayUrl')
  }

  async start(): Promise<void> {
    if (!this.appId) throw new Error('缺少 AppID')
    if (!this.clientSecret) throw new Error('缺少 AppSecret')
    await this.accessToken()
    const gateway = this.gatewayUrlOverride || (await this.fetchGateway())
    await this.connect(gateway)
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
    chatType: 'private' | 'group',
    text: string,
    options?: SendOptions
  ): Promise<void> {
    for (const part of splitMessage(text, QQBOT_LIMIT)) {
      const path =
        chatType === 'group'
          ? `/v2/groups/${encodeURIComponent(chatId)}/messages`
          : `/v2/users/${encodeURIComponent(chatId)}/messages`
      await this.api(path, 'POST', {
        content: part,
        msg_type: 0,
        ...(options?.replyTo
          ? { msg_id: options.replyTo, msg_seq: Math.floor(Math.random() * 100_000) }
          : {})
      })
    }
  }

  private async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      let greeted = false
      ws.on('message', (data) => {
        let payload: QqPayload
        try {
          payload = JSON.parse(String(data)) as QqPayload
        } catch {
          return
        }
        if (typeof payload.s === 'number') this.seq = payload.s
        switch (payload.op) {
          case 10: {
            const interval = Number(
              (payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 30_000
            )
            this.heartbeat = setInterval(() => this.sendHeartbeat(), Math.max(5_000, interval))
            this.heartbeat.unref()
            this.sendHeartbeat()
            this.identify()
            greeted = true
            this.state = {
              state: 'running',
              detail: `机器人 ${this.appId}`,
              since: Date.now()
            }
            resolve()
            return
          }
          case 11:
            return
          case 1:
            this.sendHeartbeat()
            return
          case 7:
          case 9:
            this.reconnect()
            return
          case 0:
            void this.onDispatch(payload)
            return
          default:
            return
        }
      })
      ws.on('error', (error) => {
        this.state = { state: 'error', detail: error.message, since: Date.now() }
        if (!greeted) reject(error)
      })
      ws.on('close', () => {
        this.ws = null
        if (this.heartbeat) clearInterval(this.heartbeat)
        this.heartbeat = null
        if (this.stopped) return
        if (!greeted) {
          this.state = { state: 'error', detail: 'Gateway 握手失败', since: Date.now() }
          reject(new Error('QQ Gateway 握手失败'))
          return
        }
        this.state = { state: 'error', detail: '连接已断开，正在重连', since: Date.now() }
        this.scheduleReconnect()
      })
    })
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
          token: `QQBot ${this.accessTokenValue}`,
          intents: INTENTS,
          shard: [0, 1],
          properties: { os: process.platform, browser: 'amadeus', device: 'amadeus' }
        }
      })
    )
  }

  private async onDispatch(payload: QqPayload): Promise<void> {
    if (payload.t !== 'C2C_MESSAGE_CREATE' && payload.t !== 'GROUP_AT_MESSAGE_CREATE') return
    const message = payload.d as QqMessage | undefined
    if (!message) return
    const isGroup = payload.t === 'GROUP_AT_MESSAGE_CREATE'
    const chatId = isGroup ? message.group_openid : message.author?.user_openid
    const externalUserId = isGroup
      ? message.author?.member_openid
      : message.author?.user_openid
    if (!chatId || !externalUserId) return
    const text = (message.content ?? '').replace(/<@!?\d+>/g, '').trim()
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
        console.warn('[qqbot] 附件下载失败：', error instanceof Error ? error.message : error)
      }
    }
    if (!text && media.length === 0) return
    this.ctx.onMessage({
      externalUserId,
      chatId,
      chatType: isGroup ? 'group' : 'private',
      text,
      messageId: message.id,
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
      void this.accessToken()
        .then(() => this.fetchGateway())
        .then((url) => this.connect(url))
        .catch(() => this.scheduleReconnect())
    }, 3_000)
    this.reconnectTimer.unref()
  }

  private async fetchGateway(): Promise<string> {
    const json = (await this.api<{ url?: string }>('/gateway', 'GET')) as { url?: string }
    if (!json.url) throw new Error('QQ Gateway 地址为空')
    return json.url
  }

  private async accessToken(): Promise<string> {
    if (this.accessTokenValue && Date.now() < this.accessTokenExpiresAt) return this.accessTokenValue
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      signal: AbortSignal.timeout(20_000)
    })
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number | string; message?: string }
      | null
    if (!res.ok || !json?.access_token) {
      throw new Error(`QQ access_token 获取失败：${json?.message ?? `HTTP ${res.status}`}`)
    }
    this.accessTokenValue = json.access_token
    const expires = Number(json.expires_in ?? 7200)
    this.accessTokenExpiresAt = Date.now() + Math.max(60, expires - 120) * 1000
    return this.accessTokenValue
  }

  private async api<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.accessToken()
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000)
    })
    if (res.status === 401 && !retried) {
      this.accessTokenValue = ''
      return this.api<T>(path, method, body, true)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`QQ HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`)
    }
    return (await res.json().catch(() => ({}))) as T
  }
}
