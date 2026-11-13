import type { PlatformInbound, PlatformStatus } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import type { Db, PlatformRow } from '../db.ts'
import { DiscordAdapter } from './discord.ts'
import { OneBotAdapter } from './onebot.ts'
import { handlePlatformMessage } from './pipeline.ts'
import { SlackAdapter } from './slack.ts'
import { TelegramAdapter } from './telegram.ts'
import type { PlatformAdapter } from './types.ts'
import { WebhookAdapter } from './webhook.ts'

interface Entry {
  row: PlatformRow
  adapter: PlatformAdapter
  /** 启动时的配置指纹：配置改了要重启适配器 */
  configKey: string
}

/**
 * 平台适配器生命周期：启动已启用的平台、配置变化时重启、提供状态与测试发送。
 * 一个平台起不来只影响它自己，不阻塞大脑启动。
 */
class PlatformManager {
  private cfg: BrainConfig | null = null
  private db: Db | null = null
  private entries = new Map<string, Entry>()

  async init(cfg: BrainConfig, db: Db): Promise<void> {
    this.cfg = cfg
    this.db = db
    const rows = await db.listPlatforms()
    for (const row of rows) {
      if (!row.enabled) continue
      await this.start(row).catch((error) => {
        console.warn(
          `[platform:${row.kind}] 启动失败：`,
          error instanceof Error ? error.message : error
        )
      })
    }
  }

  /** 平台增删改/启停后调用：按数据库现状对齐运行中的适配器 */
  async sync(): Promise<void> {
    if (!this.db) return
    const rows = await this.db.listPlatforms()
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const [id, entry] of [...this.entries]) {
      const row = byId.get(id)
      // 被删除、被停用、或配置变了：先停掉旧适配器
      if (!row || !row.enabled || JSON.stringify(row.config) !== entry.configKey) {
        this.stopEntry(id)
      }
    }
    for (const row of rows) {
      if (!row.enabled || this.entries.has(row.id)) continue
      await this.start(row).catch((error) => {
        console.warn(
          `[platform:${row.kind}] 启动失败：`,
          error instanceof Error ? error.message : error
        )
      })
    }
  }

  statusOf(id: string): PlatformStatus {
    return this.entries.get(id)?.adapter.status() ?? { state: 'stopped' }
  }

  /** 发一条真实测试消息；Telegram/OneBot 需要配置里的测试会话 ID */
  async sendTest(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, error: '平台未运行（请先启用）' }
    const config = entry.row.config
    const rawTarget = typeof config.testChatId === 'string' ? config.testChatId.trim() : ''
    if (entry.row.kind === 'webhook') {
      await entry.adapter.send('test', 'private', 'Amadeus 测试消息：连通正常。')
      return { ok: true }
    }
    if (!rawTarget) return { ok: false, error: '请先在配置里填写测试会话 ID' }
    let chatId = rawTarget
    let chatType: 'private' | 'group' = 'private'
    const match = /^(group|private):(.+)$/.exec(rawTarget)
    if (match) {
      chatType = match[1] as 'private' | 'group'
      chatId = match[2]!
    }
    await entry.adapter.send(chatId, chatType, 'Amadeus 测试消息：连通正常。')
    return { ok: true }
  }

  /** 通用 Webhook 入站：校验密钥 → 异步跑回合（立即返回 202） */
  async handleWebhook(
    id: string,
    payload: Record<string, unknown>,
    secretHeader: string
  ): Promise<{ ok: boolean; status: number; error?: string }> {
    if (!this.db || !this.cfg) return { ok: false, status: 503, error: '服务未就绪' }
    const row = await this.db.getPlatform(id)
    if (!row || row.kind !== 'webhook') return { ok: false, status: 404, error: '平台不存在' }
    if (!row.enabled) return { ok: false, status: 403, error: '平台已停用' }
    const expected = typeof row.config.secret === 'string' ? row.config.secret : ''
    if (expected && secretHeader !== expected) {
      return { ok: false, status: 401, error: '密钥不匹配' }
    }
    const externalUserId =
      typeof payload.externalUserId === 'string' ? payload.externalUserId.trim() : ''
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (!externalUserId || !text.trim()) {
      return { ok: false, status: 400, error: 'externalUserId/text 必填' }
    }
    const chatId =
      typeof payload.chatId === 'string' && payload.chatId.trim()
        ? payload.chatId.trim()
        : externalUserId
    const chatType: 'private' | 'group' = payload.chatType === 'group' ? 'group' : 'private'
    const inbound: PlatformInbound = { externalUserId, chatId, chatType, text }
    const replyUrl = typeof payload.replyUrl === 'string' ? payload.replyUrl.trim() : ''
    const reply = replyUrl
      ? async (replyText: string): Promise<void> => {
          await fetch(replyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(expected ? { 'x-amadeus-secret': expected } : {})
            },
            body: JSON.stringify({
              type: 'message',
              platformId: id,
              chatId,
              chatType,
              text: replyText
            })
          })
        }
      : (() => {
          const entry = this.entries.get(id)
          return entry
            ? (replyText: string): Promise<void> =>
                entry.adapter.send(chatId, chatType, replyText)
            : null
        })()
    if (!reply) return { ok: false, status: 409, error: '平台未运行' }

    void handlePlatformMessage({
      cfg: this.cfg,
      db: this.db,
      platform: row,
      inbound,
      reply
    }).catch((error) => {
      console.warn('[platform:webhook] 回合失败：', error instanceof Error ? error.message : error)
    })
    return { ok: true, status: 202 }
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.stopEntry(id)
  }

  private async start(row: PlatformRow): Promise<void> {
    const adapter = this.buildAdapter(row)
    await adapter.start()
    this.entries.set(row.id, { row, adapter, configKey: JSON.stringify(row.config) })
  }

  private stopEntry(id: string): void {
    this.entries.get(id)?.adapter.stop()
    this.entries.delete(id)
  }

  private buildAdapter(row: PlatformRow): PlatformAdapter {
    const ctx = {
      platformId: row.id,
      name: row.name,
      config: row.config,
      onMessage: (inbound: PlatformInbound): void => {
        void this.dispatch(row.id, inbound)
      }
    }
    switch (row.kind) {
      case 'telegram':
        return new TelegramAdapter(ctx)
      case 'onebot':
        return new OneBotAdapter(ctx)
      case 'webhook':
        return new WebhookAdapter(ctx)
      case 'discord':
        return new DiscordAdapter(ctx)
      case 'slack':
        return new SlackAdapter(ctx)
    }
  }

  private async dispatch(id: string, inbound: PlatformInbound): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || !this.cfg || !this.db) return
    try {
      await handlePlatformMessage({
        cfg: this.cfg,
        db: this.db,
        platform: entry.row,
        inbound,
        reply: (text) => entry.adapter.send(inbound.chatId, inbound.chatType, text)
      })
    } catch (error) {
      console.warn('[platform] 消息处理失败：', error instanceof Error ? error.message : error)
    }
  }
}

/** 进程级单例（与 skills/plugins 同前提：一个 brain 一套平台配置） */
export const platformManager = new PlatformManager()
