import { randomUUID } from 'node:crypto'
import type { Channel, CompactionLevel, SseEvent, TurnMode, UserConfig } from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'
import { buildHistory, type CompactionReport } from './context/compact.ts'
import { summaryMessageContent } from './context/prompt.ts'
import type { Db } from './db.ts'
import { streamText, supportsVision, toContextMessages, type LlmTarget } from './llm.ts'
import { memorySystemPrompt, onTurnFinished, recallMemories, summarizeAffinity } from './memory/index.ts'
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

/**
 * 用户 LLM 目标：激活的模型服务优先；没有服务（或服务没配密钥）时回落到
 * 设置页的单条内置配置，再回落到 .env 默认。
 */
export async function resolveTarget(cfg: BrainConfig, db: Db, userId: string): Promise<LlmTarget> {
  const active = await db.getActiveProvider()
  if (active && active.apiKey.trim()) {
    return {
      baseUrl: active.baseUrl,
      apiKey: active.apiKey,
      model: active.model,
      vision: supportsVision(active.model),
      proxy: active.proxy,
      providerId: active.id,
      providerName: active.name
    }
  }
  const stored = await db.getUserConfig(userId)
  const provider = stored?.provider
  const model = provider?.model || cfg.llm.model
  return {
    baseUrl: provider?.baseUrl || cfg.llm.baseUrl,
    apiKey: provider?.apiKey || cfg.llm.apiKey,
    model,
    vision: supportsVision(model),
    proxy: provider?.proxy || '',
    providerName: ''
  }
}

export function defaultUserConfig(cfg: BrainConfig): UserConfig {
  return {
    provider: { baseUrl: cfg.llm.baseUrl, apiKey: '', model: cfg.llm.model },
    outputLanguage: 'zh',
    systemPrompt: '',
    temperature: 0.8,
    tools: { enabled: true },
    // 缺省 balanced：只在接近上下文上限时才摘要，普通会话无额外开销
    compaction: { level: 'balanced' },
    // 缺省 off：动态工作流会并发调用多个子代理，必须由用户显式开启档位
    workflow: { level: 'off' }
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
  /** 回合取消信号：中断上下文压缩的摘要请求（不写边界） */
  signal?: AbortSignal
  /** 语音模式附加的视觉帧（仅本次 LLM 请求，不落库） */
  frames?: string[]
  /**
   * 是否把本次用户消息写入会话。缺省 true（普通回合）；
   * 重新生成时传 false——活动世界线末端已经有那条用户消息，再写一遍会重复两问一答。
   */
  appendUserMessage?: boolean
}

export interface PreparedTurn {
  target: LlmTarget
  systemPrompt: string
  /** 含本次用户消息的完整 LLM 上下文消息 */
  messages: ReturnType<typeof toContextMessages>
  /** prepareTurn 已读取的用户配置（工具开关等，避免调用方二次 DB 读） */
  userConfig: UserConfig | null
  /** 本回合新做的上下文压缩（未压缩时为 undefined；调用方据此发提示事件） */
  compaction?: CompactionReport
  /** 本回合用户消息的 id（助手回复以它为父节点；重新生成时是已存在的那条） */
  userMessageId: string
}

/** 压缩档位：配置缺省按 balanced（与 UI 默认一致）；非法值回落缺省 */
export function compactionLevelOf(config: UserConfig | null): CompactionLevel {
  const level = config?.compaction?.level
  return level === 'off' || level === 'aggressive' || level === 'balanced' ? level : 'balanced'
}

/** 会话上下文准备：懒建会话行、保存用户消息、组装 LLM 上下文 */
export async function prepareTurn(ctx: TurnContext): Promise<PreparedTurn> {
  const { cfg, db, userId, sessionId, channel, mode, content, frames } = ctx
  const appendUserMessage = ctx.appendUserMessage !== false
  await db.touchSession({ id: sessionId, userId, channel })

  // 用户配置与目标模型先解析：压缩档位来自配置，摘要请求需要 target
  const storedConfig = await db.getUserConfig(userId)
  const target = await resolveTarget(cfg, db, userId)
  const compactionLevel = compactionLevelOf(storedConfig)

  // 当前世界线末端（活动叶）：新消息接在它后面；空会话为 null
  const headId = await db.getActiveMessageId(sessionId)

  // 先读历史再落库本次用户消息：避免当前消息在 LLM 上下文里出现两次
  // （一次纯文本历史、一次带视觉帧）
  // 记忆召回与好感度摘要都来自真实数据；没有记录时返回空，不会凭空生成
  const [prepared, recalledMemories, affinity] = await Promise.all([
    buildHistory({
      db,
      target,
      sessionId,
      level: compactionLevel,
      signal: ctx.signal
    }),
    recallMemories(db, userId, content),
    summarizeAffinity(db, userId)
  ])

  const historyRows = prepared.rows

  // 状态转移：用户消息作为活动叶的子节点落库，活动叶前移到它。
  // 重新生成（appendUserMessage=false）不写新消息，直接沿用已存在的末条用户消息。
  let userMessageId: string
  if (appendUserMessage) {
    userMessageId = randomUUID()
    await db.appendMessage({
      id: userMessageId,
      sessionId,
      parentId: headId,
      role: 'user',
      content,
      mode
    })
    await db.setActiveMessage(sessionId, userMessageId)
  } else {
    const last = historyRows[historyRows.length - 1]
    if (!last) throw new Error('重新生成失败：世界线上没有可用的用户消息')
    userMessageId = last.id
  }

  const systemPrompt =
    buildSystemPrompt(storedConfig?.systemPrompt, mode) + memorySystemPrompt(recalledMemories, affinity)

  const messages = toContextMessages(
    historyRows.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
  )
  // 摘要放在历史最前面：它是背景，不是本轮用户请求
  if (prepared.summary) {
    messages.unshift({ role: 'user', content: summaryMessageContent(prepared.summary), timestamp: 0 })
  }

  // 语音模式：本次用户消息附加最近 2 帧视觉输入（image content 块）。
  // 纯文本模型（如 deepseek-v4-pro）收到 image 块会直接 400——按模型能力门控
  const hasFrames = mode === 'voice' && frames !== undefined && frames.length > 0
  if (hasFrames && !target.vision) {
    console.warn(`[voice] 模型 ${target.model} 不支持图像输入，跳过 ${frames.length} 帧视觉输入`)
  }
  const attachFrames = hasFrames && target.vision

  if (appendUserMessage) {
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
  } else if (historyRows.at(-1)?.role !== 'user') {
    // 不追加时上下文必须以本次用户消息收尾：否则 agent.prompt(content) 会把它
    // 再塞一次，模型看到重复提问（重新生成的定位逻辑保证末尾是用户消息）
    throw new Error('重新生成失败：会话末尾没有用户消息')
  }

  return {
    target,
    systemPrompt,
    messages,
    userConfig: storedConfig,
    compaction: prepared.report,
    userMessageId
  }
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
    /** 本回合用户消息 id（助手回复以它为父节点） */
    userMessageId: string
    /** 本回合工具调用次数（好感度事件用） */
    toolCalls?: number
  }
): Promise<string> {
  const assistantId = randomUUID()
  const countBefore = await db.countMessages(input.sessionId)
  // 状态转移：助手回复作为用户消息的子节点落库，活动叶前移到它。
  // 重新生成时旧回复不删——它成为同一父节点下的兄弟，也就是另一条世界线。
  await db.appendMessage({
    id: assistantId,
    sessionId: input.sessionId,
    parentId: input.userMessageId,
    role: 'assistant',
    content: input.content,
    ttsText: input.ttsText,
    mode: input.mode
  })
  await db.setActiveMessage(input.sessionId, assistantId)
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

  // 记忆提取与好感度：后台执行，绝不阻塞或影响已完成的回合
  void onTurnFinished({
    db,
    target: input.target,
    userId: input.userId,
    sessionId: input.sessionId,
    messageId: assistantId,
    userText: input.userText,
    assistantText: input.content,
    toolCalls: input.toolCalls ?? 0
  }).catch((error) => {
    console.warn('[memory] 回合记忆/好感更新失败：', error instanceof Error ? error.message : error)
  })
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
  ttsConfig: TtsConfig,
  onUsage?: (usage: { input: number; output: number; total: number }) => void
): AsyncGenerator<SseEvent, { cn: string; jp: string; userMessageId: string }> {
  // 语音回合同样走压缩（长会话的语音对话也会撞上限）；signal 用于中断摘要请求
  const { target, systemPrompt, messages, userMessageId } = await prepareTurn({ ...ctx, signal })

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
    for await (const delta of streamText(target, { systemPrompt, messages }, { signal }, onUsage)) {
      const out = parser.feed(delta)
      // 按行内出现顺序发事件：动作不会先于它从属的文本到达，多情绪都发（后者覆盖）
      for (const ev of out.events) {
        if (ev.type === 'emotion') yield { type: 'emotion', emotion: ev.emotion }
        else if (ev.type === 'gesture') yield { type: 'gesture', gesture: ev.gesture }
        else yield { type: 'delta', delta: ev.text }
      }
      for (const jp of out.jpSentences) jpQueue.push(jp)
      // 非阻塞排出已就绪的音频块，与文本事件交错
      for (let audio = audioQueue.tryShift(); audio !== undefined; audio = audioQueue.tryShift()) {
        yield { type: 'audio', data: audio.data, sampleRate: audio.sampleRate }
      }
    }
    const fin = parser.finish()
    for (const ev of fin.events) {
      if (ev.type === 'emotion') yield { type: 'emotion', emotion: ev.emotion }
      else if (ev.type === 'gesture') yield { type: 'gesture', gesture: ev.gesture }
      else yield { type: 'delta', delta: ev.text }
    }
    for (const jp of fin.jpSentences) jpQueue.push(jp)
  } finally {
    jpQueue.close()
  }

  // LLM 流结束后排空剩余 TTS 音频
  for await (const audio of audioQueue) {
    yield { type: 'audio', data: audio.data, sampleRate: audio.sampleRate }
  }

  return { cn: parser.cn, jp: parser.jp, userMessageId }
}
