import { Hono } from 'hono'
import { runAgentTurn, type AgentTurnResult } from '../agentTurn.ts'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'
import { finishTurn } from '../conversation.ts'

/**
 * 飞书渠道：与桌面共享同一对话服务与数据库（channel='feishu'）。
 * - @提及（群聊）或私聊触发回复；回复走文本模式中文
 * - 发送绑定码（桌面设置页生成）完成用户身份绑定
 * - 会话按 chat_id 一个会话（desktop 端可在聊天列表看到并继续）
 */

interface FeishuMessageEvent {
  type: 'im.message.receive_v1'
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    message_type: string
    content?: string
    mentions?: { id?: { open_id?: string } }[]
  }
  sender?: { sender_id?: { open_id?: string }; sender_type?: string }
}

const API_HOST = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' }

export function feishuRoutes(cfg: BrainConfig, db: Db): Hono {
  const app = new Hono()

  // tenant_access_token 缓存（expire 秒数，提前 60s 过期）
  let token: { value: string; expiresAt: number } | null = null
  let botOpenId: string | null = null

  async function tenantToken(): Promise<string> {
    if (token && token.expiresAt > Date.now()) return token.value
    const res = await fetch(`${API_HOST[cfg.feishu.domain]}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.feishu.appId, app_secret: cfg.feishu.appSecret })
    })
    if (!res.ok) throw new Error(`飞书 tenant_access_token 获取失败: HTTP ${res.status}`)
    const json = (await res.json()) as { tenant_access_token?: string; expire?: number }
    if (!json.tenant_access_token) throw new Error('飞书 tenant_access_token 响应缺失')
    token = { value: json.tenant_access_token, expiresAt: Date.now() + (json.expire ?? 7200) * 1000 - 60_000 }
    return token.value
  }

  async function botInfo(): Promise<string | null> {
    if (botOpenId) return botOpenId
    try {
      const tk = await tenantToken()
      const res = await fetch(`${API_HOST[cfg.feishu.domain]}/open-apis/bot/v3/info`, {
        headers: { Authorization: `Bearer ${tk}` }
      })
      if (!res.ok) return null
      const json = (await res.json()) as { bot?: { open_id?: string } }
      botOpenId = json.bot?.open_id ?? null
      return botOpenId
    } catch {
      return null
    }
  }

  async function reply(messageId: string, text: string): Promise<void> {
    const tk = await tenantToken()
    await fetch(`${API_HOST[cfg.feishu.domain]}/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) })
    })
  }

  async function runFeishuTurn(openId: string, chatId: string, text: string): Promise<string> {
    // 用户：已绑定的直接用；未绑定则按 open_id 自动建档（username 前缀标记渠道）
    let user = await db.findUserByFeishu(openId)
    if (!user) {
      user = { id: (await db.resolveUser(`feishu-${openId}`)).id, username: `feishu-${openId}` }
    }
    const sessionId = `feishu-${chatId}`

    // 工具版回合（渠道 feishu：注册表不含 bash，无确认通道；工具事件仅日志）
    const run = runAgentTurn({
      cfg,
      db,
      userId: user.id,
      sessionId,
      channel: 'feishu',
      mode: 'text',
      content: text,
      signal: AbortSignal.timeout(300_000),
      temperature: 0.7
    })

    let full = ''
    let target: AgentTurnResult['target'] | null = null
    let next = await run.next()
    while (!next.done) {
      const ev = next.value
      if (ev.type.startsWith('tool')) {
        console.log(`[feishu][tool] ${ev.type} ${'toolName' in ev ? ev.toolName : ''}`)
      } else if (ev.type === 'delta') {
        full += ev.delta
      }
      next = await run.next()
    }
    full = next.value.full || full
    target = next.value.target
    if (!full || !target) return '……（大脑空空如也，哼）'

    await finishTurn(db, {
      sessionId,
      userId: user.id,
      channel: 'feishu',
      mode: 'text',
      content: full,
      ttsText: null,
      target,
      userText: text
    })
    return full
  }

  app.post('/feishu/webhook', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { type?: string; challenge?: string; event?: FeishuMessageEvent }
      | null
    if (!body?.type) return c.json({}, 400)

    // URL 校验握手
    if (body.type === 'url_verification') {
      return c.json({ challenge: body.challenge ?? '' })
    }
    if (body.type !== 'event_callback' || !body.event) return c.json({})

    const event = body.event
    if (event.type !== 'im.message.receive_v1' || event.message?.message_type !== 'text') {
      return c.json({})
    }

    // 忽略机器人自己的消息
    if (event.sender?.sender_type === 'bot') return c.json({})

    const openId = event.sender?.sender_id?.open_id
    const chatId = event.message.chat_id
    if (!openId || !chatId) return c.json({})

    let text = ''
    try {
      const parsed = JSON.parse(event.message.content ?? '{}') as { text?: string }
      text = (parsed.text ?? '').trim()
    } catch {
      text = ''
    }
    if (!text) return c.json({})

    // @提及判断：私聊直接回；群聊需 @机器人
    const isP2p = event.message.chat_type === 'p2p'
    if (!isP2p) {
      const bot = await botInfo()
      const mentioned = event.message.mentions?.some((m) => m.id?.open_id === bot) ?? false
      if (!mentioned) return c.json({})
    }

    // 不阻塞 webhook 应答：飞书 3 秒超时内先回 200，处理异步进行
    void (async () => {
      try {
        // 绑定码：AMADEUS-XXXX → 绑定身份
        const bindCodeMatch = /AMADEUS-\d{4}/.exec(text)
        if (bindCodeMatch) {
          const bindUser = await db.findUserByBindCode(bindCodeMatch[0])
          if (bindUser) {
            await db.bindFeishu(bindUser.id, openId)
            await reply(event.message.message_id, `绑定成功！你现在是「${bindUser.username}」，我们共享同一份对话记录。`)
            return
          }
          await reply(event.message.message_id, '绑定码无效，笨蛋。去桌面端的设置页重新复制一个。')
          return
        }
        const answer = await runFeishuTurn(openId, chatId, text)
        await reply(event.message.message_id, answer)
      } catch (error) {
        console.error('[feishu] 处理失败：', error instanceof Error ? error.message : error)
        try {
          await reply(event.message.message_id, '呜……处理出错了，等会儿再试吧。')
        } catch {
          // 回复失败就算了
        }
      }
    })()

    return c.json({})
  })

  return app
}
