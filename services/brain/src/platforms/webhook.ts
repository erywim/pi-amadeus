import type { PlatformStatus } from '@pi-amadeus/shared'
import { configString, splitMessage, type AdapterContext, type PlatformAdapter } from './types.ts'

/**
 * 通用 Webhook 平台：入站走 POST /api/platforms/:id/webhook，出站 POST 到配置的地址。
 * 适合接自建桥接、IFTTT、n8n、企业微信机器人等任何能收发 HTTP 的服务。
 */
export class WebhookAdapter implements PlatformAdapter {
  private state: PlatformStatus = { state: 'stopped' }
  private readonly ctx: AdapterContext
  private readonly outboundUrl: string
  private readonly secret: string

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.outboundUrl = configString(ctx.config, 'outboundUrl')
    this.secret = configString(ctx.config, 'secret')
  }

  async start(): Promise<void> {
    if (!this.outboundUrl) throw new Error('缺少出站地址（outboundUrl）')
    this.state = { state: 'running', detail: this.outboundUrl, since: Date.now() }
  }

  stop(): void {
    this.state = { state: 'stopped' }
  }

  status(): PlatformStatus {
    return this.state
  }

  async send(chatId: string, chatType: 'private' | 'group', text: string): Promise<void> {
    if (!this.outboundUrl) throw new Error('缺少出站地址')
    for (const part of splitMessage(text)) {
      const res = await fetch(this.outboundUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.secret ? { 'x-amadeus-secret': this.secret } : {})
        },
        body: JSON.stringify({
          type: 'message',
          platformId: this.ctx.platformId,
          platformName: this.ctx.name,
          chatId,
          chatType,
          text: part
        })
      })
      if (!res.ok) throw new Error(`Webhook 出站失败：HTTP ${res.status}`)
    }
  }
}
