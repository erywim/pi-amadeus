import { randomUUID } from 'node:crypto'
import { EMOTIONS, normalizeEmotion, type Emotion, type ProactiveGreeting } from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'
import type { Db } from './db.ts'
import { resolveTarget } from './conversation.ts'
import { streamText, toContextMessages } from './llm.ts'
import { recordTurnMetric } from './metrics.ts'
import { buildSystemPrompt } from './persona.ts'

/**
 * 主动问候：把桌面截图交给视觉模型，产出 1~2 句中文并落库成助手消息。
 *
 * 与普通回合的区别（刻意为之，不是遗漏）：
 * - 截图与"系统提示"这条用户消息**不落库**——聊天记录里只留她说的那句话，
 *   用户看到的是"她主动开口"，而不是一条自己没发过的消息；
 * - 不触发记忆提取与好感度：那些只由真实用户回合产生；
 * - 模型不支持图像输入时直接拒绝（422）。没有视觉就没有"看到桌面"，
 *   退化成定时随机搭话只会变成噪音。
 *
 * 隐私：截图只活在本次请求里（不落库、不写日志），最终发给用户自己配置的模型服务。
 */

/** 主动问候带多少条历史：够她接上前文，又不让截图请求的 token 失控 */
const HISTORY_LIMIT = 20

/** 给模型的系统侧指令（用户消息正文；截图作为 image 块跟在后面） */
const PROACTIVE_TRIGGER = '（系统：这是用户此刻电脑屏幕的截图，请据此主动开口。）'

const PROACTIVE_INSTRUCTIONS = `【主动搭话——本轮不是用户提问】
你刚刚瞥见了用户此刻的电脑屏幕（截图附在本条消息里）。请据此主动开口，像一直陪在旁边的红莉栖那样自然地说 1~2 句中文：
1. 先判断用户正在做什么（写代码 / 看文档 / 看视频 / 打游戏 / 开会 / 发呆……），再决定说什么
2. 不要复述截图里的具体文字、窗口标题、网址、文件名或聊天内容，也不要说"我看到你的屏幕""根据截图"这类话
3. 可以关心、吐槽、好奇、提醒休息，或顺着屏幕上正在做的事接一句；保持傲娇、毒舌但不冒犯
4. 第一行单独写【情】<情绪英文名>（从下列中选一个），第二行开始是中文正文：${EMOTIONS.join('、')}
5. 正文只输出中文口语，不要 markdown、不要列表、不要引号`

export interface ProactiveInput {
  cfg: BrainConfig
  db: Db
  userId: string
  /** 期望落库的会话；空=用该用户最近更新的会话，没有会话则新建 */
  sessionId?: string
  /** base64 JPEG 桌面截图 */
  frame: string
  signal?: AbortSignal
}

export type ProactiveOutcome =
  | { ok: true; greeting: ProactiveGreeting; model: string }
  | { ok: false; status: 404 | 422 | 502; code: string; error: string }

/** 解析模型回复：首行【情】是情绪（非法值按没有处理），其余行是正文；任何位置的孤立情绪行都剔除 */
export function parseProactiveReply(raw: string): { text: string; emotion: Emotion | null } {
  const lines = raw.trim().split('\n')
  let emotion: Emotion | null = null
  const first = lines[0]?.trim() ?? ''
  const match = /^【情】\s*([a-zA-Z]+)\s*$/.exec(first)
  if (match) {
    emotion = normalizeEmotion(match[1])
    lines.shift()
  }
  const text = lines
    .filter((line) => !/^\s*【情】/.test(line))
    .join('\n')
    .trim()
  return { text, emotion }
}

export async function runProactiveGreeting(input: ProactiveInput): Promise<ProactiveOutcome> {
  const { cfg, db, userId, frame, signal } = input

  // 用户归属校验必须先于模型解析与截图转发；否则未知 userId 会在落库时才触发外键 500，
  // 还会白白把屏幕内容发给模型。
  if (!(await db.getUser(userId))) {
    return { ok: false, status: 404, code: 'user_not_found', error: '用户不存在' }
  }

  // 指定会话必须存在、属于该用户且是桌面会话；不指定则只接最近的桌面会话，
  // 绝不能把桌面截图写入飞书或其它通讯平台的会话。
  let sessionId = input.sessionId ?? ''
  if (sessionId) {
    const session = await db.getSession(sessionId)
    if (!session || session.userId !== userId || session.channel !== 'desktop') {
      return { ok: false, status: 404, code: 'session_not_found', error: '桌面会话不存在' }
    }
  } else {
    const sessions = await db.listSessions(userId)
    sessionId = sessions.find((session) => session.channel === 'desktop')?.id ?? randomUUID()
  }

  const target = await resolveTarget(cfg, db, userId)
  // 纯文本模型收到 image 块会直接 400：在调用前按能力拒绝，别把 400 当"问候失败"报给用户
  if (!target.vision) {
    return {
      ok: false,
      status: 422,
      code: 'no_vision',
      error: `当前模型 ${target.model} 不支持图像输入，无法识别屏幕`
    }
  }

  const [storedConfig, historyRows] = await Promise.all([
    db.getUserConfig(userId),
    db.listMessages(sessionId, HISTORY_LIMIT)
  ])
  const systemPrompt =
    buildSystemPrompt(storedConfig?.systemPrompt, 'text') + '\n\n' + PROACTIVE_INSTRUCTIONS
  const messages = toContextMessages(
    historyRows.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
  )
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: PROACTIVE_TRIGGER },
      { type: 'image', data: frame, mimeType: 'image/jpeg' }
    ],
    timestamp: Date.now()
  })

  const startedAt = Date.now()
  const usage = { input: 0, output: 0, total: 0 }
  let raw = ''
  try {
    for await (const delta of streamText(
      target,
      { systemPrompt, messages },
      { signal },
      (turnUsage) => {
        usage.input += turnUsage.input
        usage.output += turnUsage.output
        usage.total += turnUsage.total
      }
    )) {
      raw += delta
    }
  } catch (error) {
    if (signal?.aborted) {
      return { ok: false, status: 502, code: 'aborted', error: '主动问候已取消' }
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error('[proactive] 生成失败：', message)
    return { ok: false, status: 502, code: 'llm_error', error: message }
  }

  const { text, emotion } = parseProactiveReply(raw)
  if (!text) {
    return { ok: false, status: 502, code: 'empty_reply', error: 'LLM 未产出有效问候' }
  }

  // 生成成功后才落库：失败不留下一条空会话/半截记录
  await db.touchSession({ id: sessionId, userId, channel: 'desktop' })
  const messageId = randomUUID()
  await db.appendMessage({
    id: messageId,
    sessionId,
    role: 'assistant',
    content: text,
    ttsText: null,
    mode: 'text'
  })
  await recordTurnMetric(db, {
    sessionId,
    userId,
    channel: 'desktop',
    startedAt,
    model: target.model,
    providerName: target.providerName,
    usage,
    toolCalls: 0,
    toolNames: []
  })

  return {
    ok: true,
    greeting: { sessionId, messageId, text, emotion, createdAt: Date.now() },
    model: target.model
  }
}
