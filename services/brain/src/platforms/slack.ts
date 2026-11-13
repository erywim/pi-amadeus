import type { PlatformMedia, PlatformStatus } from '@pi-amadeus/shared'
import WebSocket from 'ws'
import {
  configString,
  splitMessage,
  type AdapterContext,
  type PlatformAdapter,
  type SendOptions
} from './types.ts'

/** Slack 单条消息上限约 4000 字符；按 3500 分段 */
const SLACK_LIMIT = 3500

interface SlackEnvelope {
  type?: string
  envelope_id?: string
  reason?: string
  payload?: {
    event?: {
      type?: string
      subtype?: string
      text?: string
      user?: string
      channel?: string
      channel_type?: string
      bot_id?: string
      ts?: string
      thread_ts?: string
      files?: {
        url_private?: string
        mimetype?: string
        name?: string
        size?: number
      }[]
    }
  }
}

/**
 * Slack 适配器：Socket Mode（不需要公网回调地址）。
 * - app token（xapp）只用来换取 WebSocket 地址
 * - bot token（xoxb）用来 chat.postMessage
 * 收到 events_api 信封先回 ack 再处理；机器人自己的消息与编辑/删除事件一律忽略。
 */
export class SlackAdapter implements PlatformAdapter {
  private ws: WebSocket | null = null
  private state: PlatformStatus = { state: 'stopped' }
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private selfId = ''
  private teamName = ''
  private readonly ctx: AdapterContext
  private readonly botToken: string
  private readonly appToken: string
  private readonly apiBaseUrl: string

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.botToken = configString(ctx.config, 'botToken')
    this.appToken = configString(ctx.config, 'appToken')
    this.apiBaseUrl = (configString(ctx.config, 'apiBaseUrl') || 'https://slack.com/api').replace(
      /\/+$/,
      ''
    )
  }

  async start(): Promise<void> {
    if (!this.botToken) throw new Error('缺少 Bot Token（xoxb）')
    if (!this.appToken) throw new Error('缺少 App Token（xapp，需开启 Socket Mode）')
    this.stopped = false
    const auth = await this.api<{ user_id?: string; team?: string; user?: string }>(
      'auth.test',
      this.botToken
    )
    this.selfId = auth.user_id ?? ''
    this.teamName = auth.team ?? ''
    await this.connect()
  }

  stop(): void {
    this.stopped = true
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
    for (const part of splitMessage(text, SLACK_LIMIT)) {
      const result = await this.api<{ ok?: boolean; error?: string }>('chat.postMessage', this.botToken, {
        channel: chatId,
        text: part,
        // 纯文本回复：不让 Slack 把模型输出里的链接/@ 解析成富文本副作用
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
        ...(options?.replyTo ? { thread_ts: options.replyTo } : {})
      })
      if (result.ok === false) throw new Error(`Slack 发送失败：${result.error ?? 'unknown'}`)
    }
  }

  private async connect(): Promise<void> {
    const opened = await this.api<{ ok?: boolean; url?: string; error?: string }>(
      'apps.connections.open',
      this.appToken
    )
    if (opened.ok === false || !opened.url) {
      throw new Error(`Slack Socket Mode 打开失败：${opened.error ?? 'unknown'}`)
    }
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(opened.url!)
      this.ws = ws
      let greeted = false
      ws.on('message', (data) => {
        let envelope: SlackEnvelope
        try {
          envelope = JSON.parse(String(data)) as SlackEnvelope
        } catch {
          return
        }
        if (envelope.type === 'hello') {
          greeted = true
          this.state = {
            state: 'running',
            detail: this.teamName ? `${this.teamName} / @${this.selfId}` : 'Slack',
            since: Date.now()
          }
          resolve()
          return
        }
        if (envelope.type === 'disconnect') {
          ws.close()
          return
        }
        if (envelope.type === 'events_api') {
          // 先 ack：Slack 3 秒内收不到 ack 会重投同一条事件
          if (envelope.envelope_id) {
            ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
          }
          this.onEvent(envelope)
        }
      })
      ws.on('error', (error) => {
        this.state = { state: 'error', detail: error.message, since: Date.now() }
        if (!greeted) reject(error)
      })
      ws.on('close', () => {
        this.ws = null
        if (this.stopped) return
        if (!greeted) {
          this.state = { state: 'error', detail: 'Socket Mode 握手失败', since: Date.now() }
          reject(new Error('Slack Socket Mode 握手失败'))
          return
        }
        this.state = { state: 'error', detail: '连接已断开，正在重连', since: Date.now() }
        this.scheduleReconnect()
      })
    })
  }

  private onEvent(envelope: SlackEnvelope): void {
    const event = envelope.payload?.event
    if (!event || event.type !== 'message') return
    // 忽略编辑/删除/加入频道等子类型，以及机器人自己的消息与其它 bot
    if (event.subtype) return
    if (event.bot_id) return
    if (event.user && this.selfId && event.user === this.selfId) return
    const text = event.text ?? ''
    if ((!text.trim() && (event.files?.length ?? 0) === 0) || !event.channel) return
    void this.handleMessage(event)
  }

  /** 文本 + 文件 + 线程回复；Slack 私有文件需要 bot token 才能下载 */
  private async handleMessage(event: NonNullable<SlackEnvelope['payload']>['event']): Promise<void> {
    if (!event?.channel) return
    const media: PlatformMedia[] = []
    for (const file of event.files ?? []) {
      if (!file.url_private || (file.size ?? 0) > 20 * 1024 * 1024) continue
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.botToken}` },
          signal: AbortSignal.timeout(30_000)
        })
        if (!res.ok) continue
        const buffer = Buffer.from(await res.arrayBuffer())
        const mimeType = file.mimetype || 'application/octet-stream'
        media.push({
          kind: mimeType.startsWith('image/')
            ? 'image'
            : mimeType.startsWith('audio/')
              ? 'audio'
              : 'file',
          name: file.name || 'attachment',
          mimeType,
          data: buffer.toString('base64'),
          size: buffer.length
        })
      } catch (error) {
        console.warn('[slack] 附件下载失败：', error instanceof Error ? error.message : error)
      }
    }
    this.ctx.onMessage({
      externalUserId: String(event.user ?? ''),
      chatId: String(event.channel),
      chatType: event.channel_type === 'im' ? 'private' : 'group',
      text: event.text ?? '',
      messageId: event.thread_ts ?? event.ts,
      media
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.connect().catch((error) => {
        this.state = {
          state: 'error',
          detail: error instanceof Error ? error.message : String(error),
          since: Date.now()
        }
        // 网络还没恢复：继续退避重连，而不是永久停在 error
        this.scheduleReconnect()
      })
    }, 3_000)
    this.reconnectTimer.unref()
  }

  private async api<T>(method: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`Slack HTTP ${res.status}`)
    return (await res.json().catch(() => ({}))) as T
  }
}
