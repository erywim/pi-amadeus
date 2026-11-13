import type { PlatformStatus } from '@pi-amadeus/shared'
import { configString, splitMessage, type AdapterContext, type PlatformAdapter } from './types.ts'

interface TelegramUpdate {
  update_id: number
  message?: {
    text?: string
    chat: { id: number; type: string }
    from?: { id: number; is_bot?: boolean }
  }
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

  async send(chatId: string, _chatType: 'private' | 'group', text: string): Promise<void> {
    for (const part of splitMessage(text, 4000)) {
      await this.api('sendMessage', { chat_id: chatId, text: part })
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
          if (!message?.text || message.from?.is_bot) continue
          this.ctx.onMessage({
            externalUserId: String(message.from?.id ?? message.chat.id),
            chatId: String(message.chat.id),
            chatType: message.chat.type === 'private' ? 'private' : 'group',
            text: message.text
          })
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
