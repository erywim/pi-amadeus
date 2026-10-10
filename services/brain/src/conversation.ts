import { randomUUID } from 'node:crypto'
import type { Channel, SseEvent, TurnMode, UserConfig } from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'
import type { Db } from './db.ts'
import { streamText, supportsVision, toContextMessages, type LlmTarget } from './llm.ts'
import { buildSystemPrompt } from './persona.ts'
import { generateTitle } from './title.ts'
import { AsyncQueue, BilingualParser } from './bilingual.ts'
import { ttsPcmStream } from './tts.ts'

/** 每用户的视觉帧缓存（base64 JPEG，保留最近 2 帧——v1 规格） */
const frameStore = new Map<string, string[]>()

export function pushFrame(userId: string, frame: string): void {
  const list = frameStore.get(userId) ?? []
  list.push(frame)
  while (list.length > 2) list.shift()
  frameStore.set(userId, list)
}

export function framesOf(userId: string): string[] {
  return frameStore.get(userId) ?? []
}

/** 用户 LLM 目标：用户配置优先，缺失字段回落 .env 默认 */
export async function resolveTarget(cfg: BrainConfig, db: Db, userId: string): Promise<LlmTarget> {
  const stored = await db.getUserConfig(userId)
  const provider = stored?.provider
  const model = provider?.model || cfg.llm.model
  return {
    baseUrl: provider?.baseUrl || cfg.llm.baseUrl,
    apiKey: provider?.apiKey || cfg.llm.apiKey,
    model,
    vision: supportsVision(model),
    proxy: provider?.proxy || ''
  }
}

export function defaultUserConfig(cfg: BrainConfig): UserConfig {
  return {
    provider: { baseUrl: cfg.llm.baseUrl, apiKey: '', model: cfg.llm.model },
    outputLanguage: 'zh',
    systemPrompt: '',
    temperature: 0.8,
    tools: { enabled: true }
  }
}

export interface TurnContext {
  cfg: BrainConfig
  db: Db
  userId: string
  sessionId: string
  channel: Channel
  mode: TurnMode
  content: string
  /** 语音模式附加的视觉帧（仅本次 LLM 请求，不落库） */
  frames?: string[]
}

export interface PreparedTurn {
  target: LlmTarget
  systemPrompt: string
  /** 含本次用户消息的完整 LLM 上下文消息 */
  messages: ReturnType<typeof toContextMessages>
  /** prepareTurn 已读取的用户配置（工具开关等，避免调用方二次 DB 读） */
  userConfig: UserConfig | null
}

/** 会话上下文准备：懒建会话行、保存用户消息、组装 LLM 上下文 */
export async function prepareTurn(ctx: TurnContext): Promise<PreparedTurn> {
  const { cfg, db, userId, sessionId, channel, mode, content, frames } = ctx
  await db.touchSession({ id: sessionId, userId, channel })

  // 先读历史再落库本次用户消息：避免当前消息在 LLM 上下文里出现两次
  // （一次纯文本历史、一次带视觉帧）
  const [storedConfig, historyRows] = await Promise.all([
    db.getUserConfig(userId),
    db.listMessages(sessionId, 40)
  ])

  await db.appendMessage({
    id: randomUUID(),
    sessionId,
    role: 'user',
    content,
    mode
  })

  const target = await resolveTarget(cfg, db, userId)
  const systemPrompt = buildSystemPrompt(storedConfig?.systemPrompt, mode)
  const messages = toContextMessages(
    historyRows.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
  )

  // 语音模式：本次用户消息附加最近 2 帧视觉输入（image content 块）。
  // 纯文本模型（如 deepseek-v4-pro）收到 image 块会直接 400——按模型能力门控
  const hasFrames = mode === 'voice' && frames !== undefined && frames.length > 0
  if (hasFrames && !target.vision) {
    console.warn(`[voice] 模型 ${target.model} 不支持图像输入，跳过 ${frames.length} 帧视觉输入`)
  }
  const attachFrames = hasFrames && target.vision
  const userMessage = attachFrames
    ? {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: content },
          ...frames.map((f) => ({ type: 'image' as const, data: f, mimeType: 'image/jpeg' as const }))
        ],
        timestamp: Date.now()
      }
    : { role: 'user' as const, content, timestamp: Date.now() }
  messages.push(userMessage)

  return { target, systemPrompt, messages, userConfig: storedConfig }
}

/** 保存助手消息 + 首轮触发异步标题生成 */
export async function finishTurn(
  db: Db,
  input: {
    sessionId: string
    userId: string
    channel: Channel
    mode: TurnMode
    content: string
    ttsText: string | null
    target: LlmTarget
    userText: string
  }
): Promise<string> {
  const assistantId = randomUUID()
  const countBefore = await db.countMessages(input.sessionId)
  await db.appendMessage({
    id: assistantId,
    sessionId: input.sessionId,
    role: 'assistant',
    content: input.content,
    ttsText: input.ttsText,
    mode: input.mode
  })
  await db.touchSession({ id: input.sessionId, userId: input.userId, channel: input.channel })

  // 首轮问答（此前只有 1 条用户消息）→ 异步生成标题，不阻塞 done
  if (countBefore === 1) {
    const existing = await db.getSession(input.sessionId)
    if (existing && !existing.title) {
      void generateTitle(input.target, input.userText, input.content).then(async (title) => {
        if (title) await db.setSessionTitle(input.sessionId, title)
      })
    }
  }
  return assistantId
}

export interface TtsConfig {
  apiKey: string
  voice: string
  model: string
  endpoint: string
  sampleRate: number
  proxy: string
}

/**
 * 语音回合核心：LLM 双语言流 → 中文增量上屏、日文逐句 TTS。
 * TTS 在独立 worker 中串行消费日文句子队列（有序），音频块经 AsyncQueue
 * 与文本事件交错排出——LLM 流消费不被 TTS 延迟阻塞。
 */
export async function* runVoiceTurn(
  ctx: TurnContext,
  signal: AbortSignal,
  ttsConfig: TtsConfig
): AsyncGenerator<SseEvent, { cn: string; jp: string }> {
  const { target, systemPrompt, messages } = await prepareTurn(ctx)

  const parser = new BilingualParser()
  const jpQueue = new AsyncQueue<string>()
  const audioQueue = new AsyncQueue<{ data: string; sampleRate: number }>()

  // TTS worker：逐句串行合成；单句失败跳过，不影响其余句子
  const worker = (async (): Promise<void> => {
    try {
      for await (const sentence of jpQueue) {
        try {
          for await (const chunk of ttsPcmStream(sentence, { ...ttsConfig, signal })) {
            audioQueue.push({ data: chunk.toString('base64'), sampleRate: ttsConfig.sampleRate })
          }
        } catch (error) {
          if (!signal.aborted) {
            console.warn('[voice] TTS 句子合成失败，跳过：', error instanceof Error ? error.message : error)
          }
        }
      }
    } finally {
      audioQueue.close()
    }
  })()
  void worker

  try {
    for await (const delta of streamText(target, { systemPrompt, messages }, { signal })) {
      const out = parser.feed(delta)
      if (out.emotion) yield { type: 'emotion', emotion: out.emotion }
      for (const gesture of out.gestures) yield { type: 'gesture', gesture }
      if (out.cnDelta) yield { type: 'delta', delta: out.cnDelta }
      for (const jp of out.jpSentences) jpQueue.push(jp)
      // 非阻塞排出已就绪的音频块，与文本事件交错
      for (let audio = audioQueue.tryShift(); audio !== undefined; audio = audioQueue.tryShift()) {
        yield { type: 'audio', data: audio.data, sampleRate: audio.sampleRate }
      }
    }
    const fin = parser.finish()
    if (fin.emotion) yield { type: 'emotion', emotion: fin.emotion }
    for (const gesture of fin.gestures) yield { type: 'gesture', gesture }
    if (fin.cnDelta) yield { type: 'delta', delta: fin.cnDelta }
    for (const jp of fin.jpSentences) jpQueue.push(jp)
  } finally {
    jpQueue.close()
  }

  // LLM 流结束后排空剩余 TTS 音频
  for await (const audio of audioQueue) {
    yield { type: 'audio', data: audio.data, sampleRate: audio.sampleRate }
  }

  return { cn: parser.cn, jp: parser.jp }
}
