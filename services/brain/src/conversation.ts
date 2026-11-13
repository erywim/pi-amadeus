import { randomUUID } from 'node:crypto'
import {
  ATTACHMENT_LIMITS,
  type Channel,
  type SseEvent,
  type TurnMode,
  type UserConfig
} from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'
import type { Db, MessageMediaRow } from './db.ts'
import { streamText, supportsVision, toContextMessages, type LlmTarget } from './llm.ts'
import { knowledgeSystemPrompt } from './knowledge/index.ts'
import { readAttachment, type SavedAttachment } from './media.ts'
import { isProviderCoolingDown } from './providers/failover.ts'
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
export type RoutePurpose = 'chat' | 'vision' | 'summary' | 'memory'

function startOfToday(): number {
  const date = new Date()
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 路由组：标签匹配 + 未冷却 + 未超每日配额 */
async function providerEligible(
  db: Db,
  provider: { id: string; tags: string; model: string; dailyTokenQuota: number },
  purpose: RoutePurpose
): Promise<boolean> {
  const tags = provider.tags.split(',').map((tag) => tag.trim())
  const tagMatch =
    tags.includes(purpose) ||
    (purpose === 'vision' && tags.includes('chat') && supportsVision(provider.model))
  if (!tagMatch) return false
  if (provider.dailyTokenQuota > 0) {
    const used = await db.providerUsageToday(provider.id, startOfToday())
    if (used >= provider.dailyTokenQuota) return false
  }
  return true
}

export async function resolveTarget(
  cfg: BrainConfig,
  db: Db,
  userId: string,
  purpose: RoutePurpose = 'chat'
): Promise<LlmTarget> {
  const providers = await db.listProviders()
  const active = providers.find((provider) => provider.active && provider.enabled)
  if (active && active.apiKey.trim()) {
    // 激活服务健康且符合路由组 → 用它；冷却/超配额/tag 不匹配 → 按 priority 换下一个
    if (
      !isProviderCoolingDown(active.id) &&
      (await providerEligible(db, active, purpose))
    ) {
      return targetOfProvider(active)
    }
    for (const provider of providers) {
      if (
        provider.id === active.id ||
        !provider.enabled ||
        !provider.apiKey.trim() ||
        isProviderCoolingDown(provider.id)
      ) {
        continue
      }
      if (await providerEligible(db, provider, purpose)) return targetOfProvider(provider)
    }
    // 所有服务都不可用（冷却/超配额）：回到内置配置，避免继续超额消耗
    console.warn(`[provider] 路由组 ${purpose} 没有可用服务，回落到内置配置`)
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

function targetOfProvider(provider: {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  proxy: string
}): LlmTarget {
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    vision: supportsVision(provider.model),
    proxy: provider.proxy,
    providerId: provider.id,
    providerName: provider.name
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

interface MediaContextItem {
  kind: 'image' | 'audio' | 'file'
  name: string
  extractedText: string | null
}

/**
 * 附件进入 LLM 上下文的文本形式：
 * - 文本文件 / 语音转写注入正文，总长度有上限
 * - 图片只留占位（历史图片不重复发送）
 * - 未解析的文件明确写「未解析」，不让模型猜内容
 */
function renderAttachmentContext(items: MediaContextItem[]): string {
  let budget = ATTACHMENT_LIMITS.extractedTotalChars
  const parts: string[] = []
  for (const item of items) {
    if (item.kind === 'image') {
      parts.push(`\n\n[图片：${item.name}]`)
      continue
    }
    const label = item.kind === 'audio' ? '语音' : '文件'
    if (item.extractedText) {
      const text = item.extractedText.slice(0, Math.max(0, budget))
      if (!text) continue
      budget -= text.length
      parts.push(`\n\n[${label}${item.kind === 'audio' ? '转写' : ''}：${item.name}]\n${text}`)
    } else {
      parts.push(`\n\n[${label}：${item.name}（未解析）]`)
    }
  }
  return parts.join('')
}

function mediaContext(media: MessageMediaRow[]): string {
  return renderAttachmentContext(media)
}

function savedMediaContext(items: SavedAttachment[]): string {
  return renderAttachmentContext(items)
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
  /** 本次用户消息的附件（文件已落盘；图片进视觉输入，文本进上下文） */
  attachments?: SavedAttachment[]
  /**
   * 是否把本次用户消息写入会话。缺省 true（普通回合）；
   * 重新生成时传 false——历史里已经有那条用户消息，再写一遍会重复两问一答。
   */
  appendUserMessage?: boolean
  /** 重新生成时要排除的历史消息 id（旧助手回答不进入当前上下文） */
  omitMessageId?: string
  /**
   * 从哪条消息之后分叉（编辑用户消息时传原消息的 parentId）：
   * 历史只读到这个父节点，新用户消息成为它的子节点，旧分支保留。
   * undefined = 接在当前活跃叶之后；null = 从根分叉。
   */
  branchParentId?: string | null
}

export interface PreparedTurn {
  target: LlmTarget
  systemPrompt: string
  /** 含本次用户消息的完整 LLM 上下文消息 */
  messages: ReturnType<typeof toContextMessages>
  /** prepareTurn 已读取的用户配置（工具开关等，避免调用方二次 DB 读） */
  userConfig: UserConfig | null
  /** 本次落库的用户消息 id（重新生成/编辑重发等不写用户消息时为 undefined） */
  userMessageId?: string
}

/** 会话上下文准备：懒建会话行、保存用户消息、组装 LLM 上下文 */
export async function prepareTurn(ctx: TurnContext): Promise<PreparedTurn> {
  const { cfg, db, userId, sessionId, channel, mode, content, frames } = ctx
  const appendUserMessage = ctx.appendUserMessage !== false
  await db.touchSession({ id: sessionId, userId, channel })

  // 先读历史再落库本次用户消息：避免当前消息在 LLM 上下文里出现两次
  // （一次纯文本历史、一次带视觉帧）
  // 记忆召回与好感度摘要都来自真实数据；没有记录时返回空，不会凭空生成
  // 编辑分支：历史只读到分叉父节点；parentId 为 null 时是根分支，没有历史
  const historyPromise =
    ctx.branchParentId !== undefined
      ? ctx.branchParentId
        ? db.listMessages(sessionId, 40, ctx.branchParentId)
        : Promise.resolve([])
      : db.listMessages(sessionId, 40)
  const [storedConfig, allHistoryRows, recalledMemories, affinity, knowledgePrompt] =
    await Promise.all([
      db.getUserConfig(userId),
      historyPromise,
      recallMemories(db, userId, content),
      summarizeAffinity(db, userId),
      knowledgeSystemPrompt(db, userId)
    ])

  // 重新生成：旧助手回答既不进上下文、也不删——等新回答成功落库时再替换，
  // 生成失败时旧回答仍在，用户不会因为一次失败丢掉上一版回复。
  const historyRows = ctx.omitMessageId
    ? allHistoryRows.filter((row) => row.id !== ctx.omitMessageId)
    : allHistoryRows

  const attachments = ctx.attachments ?? []
  let userMessageId: string | undefined
  if (appendUserMessage) {
    userMessageId = randomUUID()
    const parentId =
      ctx.branchParentId !== undefined ? ctx.branchParentId : (historyRows.at(-1)?.id ?? null)
    await db.appendMessage({
      id: userMessageId,
      sessionId,
      role: 'user',
      content,
      mode,
      parentId
    })
    // 附件元数据与用户消息同批落库；文件本体在 saveAttachment 时已写入数据目录
    if (attachments.length > 0) {
      await db.addMessageMedia(
        userMessageId,
        attachments.map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          mimeType: item.mimeType,
          size: item.size,
          path: item.path,
          extractedText: item.extractedText
        }))
      )
    }
  }

  const hasImageAttachment = (ctx.attachments ?? []).some((item) => item.kind === 'image')
  const target = await resolveTarget(cfg, db, userId, hasImageAttachment ? 'vision' : 'chat')
  const systemPrompt =
    buildSystemPrompt(storedConfig?.systemPrompt, mode) +
    memorySystemPrompt(recalledMemories, affinity) +
    knowledgePrompt
  // 历史里的文本附件/语音转写继续进入上下文；图片历史不重发（只保留占位说明）
  const messages = toContextMessages(
    historyRows.map((m) => ({
      role: m.role,
      content: m.content + mediaContext(m.attachments),
      createdAt: m.createdAt
    }))
  )

  // 语音模式：本次用户消息附加最近 2 帧视觉输入（image content 块）。
  // 纯文本模型（如 deepseek-v4-pro）收到 image 块会直接 400——按模型能力门控
  const hasFrames = mode === 'voice' && frames !== undefined && frames.length > 0
  if (hasFrames && !target.vision) {
    console.warn(`[voice] 模型 ${target.model} 不支持图像输入，跳过 ${frames.length} 帧视觉输入`)
  }
  const attachFrames = hasFrames && target.vision

  if (appendUserMessage) {
    const imageAttachments = attachments.filter((item) => item.kind === 'image')
    const visionNote =
      imageAttachments.length > 0 && !target.vision
        ? `\n\n[用户发送了 ${imageAttachments.length} 张图片，但当前模型不支持图像输入]`
        : ''
    const userText = content + savedMediaContext(attachments) + visionNote
    const imageBlocks = [
      ...(attachFrames
        ? frames.map((f) => ({ type: 'image' as const, data: f, mimeType: 'image/jpeg' as const }))
        : []),
      ...(target.vision
        ? imageAttachments.map((item) => ({
            type: 'image' as const,
            data: readAttachment(item.path).toString('base64'),
            mimeType: item.mimeType as 'image/png'
          }))
        : [])
    ]
    const userMessage =
      imageBlocks.length > 0
        ? {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: userText }, ...imageBlocks],
            timestamp: Date.now()
          }
        : { role: 'user' as const, content: userText, timestamp: Date.now() }
    messages.push(userMessage)
  } else if (historyRows.at(-1)?.role !== 'user') {
    // 不追加时上下文必须以本次用户消息收尾：否则 agent.prompt(content) 会把它
    // 再塞一次，模型看到重复提问（重新生成的定位逻辑保证末尾是用户消息）
    throw new Error('重新生成失败：会话末尾没有用户消息')
  }

  return { target, systemPrompt, messages, userConfig: storedConfig, userMessageId }
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
    /** 助手回复挂在哪条用户消息之后（分支树父节点）；缺省接当前活跃叶 */
    parentMessageId?: string
    /** 本回合工具调用次数（好感度事件用） */
    toolCalls?: number
  }
): Promise<string> {
  const assistantId = randomUUID()
  const countBefore = await db.countMessages(input.sessionId)
  // 旧回复不删除：它留在原分支，新回复作为子节点追加并成为活跃叶
  await db.appendMessage({
    id: assistantId,
    sessionId: input.sessionId,
    role: 'assistant',
    content: input.content,
    ttsText: input.ttsText,
    mode: input.mode,
    ...(input.parentMessageId ? { parentId: input.parentMessageId } : {})
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

  return { cn: parser.cn, jp: parser.jp }
}
