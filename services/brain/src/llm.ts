import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Context, Model, MutableModels } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

/**
 * pi-ai 接入层：把用户配置（baseUrl/apiKey/model）映射为一个
 * OpenAI 兼容自定义 provider，统一走 pi-ai 的流式管线。
 * 按 (baseUrl, model, vision) 缓存入口；apiKey/proxy 逐请求传入
 * （支持每用户独立密钥与独立代理）。
 */
export interface LlmTarget {
  baseUrl: string
  apiKey: string
  model: string
  /** 模型是否支持图像输入（决定语音回合是否附加视觉帧） */
  vision: boolean
  /** LLM 请求的本地 HTTP 代理（空 = 直连） */
  proxy?: string
}

export interface StreamOptions {
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
}

interface LlmEntry {
  models: MutableModels
  model: Model<'openai-completions'>
}

/**
 * 已知视觉模型判定：OpenAI 兼容生态常见视觉模型 id 特征。
 * 自定义模型无从查询能力清单，按生态惯例保守匹配；未知按纯文本处理
 * （纯文本模型收到 image 块会直接报 400，宁缺毋滥）。
 */
export function supportsVision(modelId: string): boolean {
  const m = modelId.toLowerCase()
  return (
    m.includes('vision') ||
    m.includes('-vl') ||
    m.includes('vl-') ||
    /gpt-4o|gpt-5|claude|gemini|minicpm|internvl|qwen2?[._]?vl|glm-4v|step-1o/.test(m) ||
    m.startsWith('o4-') ||
    m.startsWith('o3')
  )
}

const cache = new Map<string, LlmEntry>()

export function getLlm(target: LlmTarget): LlmEntry {
  const baseUrl = target.baseUrl.replace(/\/+$/, '')
  const key = `${baseUrl}|${target.model}|${target.vision}`
  const hit = cache.get(key)
  if (hit) return hit

  const model: Model<'openai-completions'> = {
    id: target.model,
    name: target.model,
    api: 'openai-completions',
    provider: 'amadeus',
    baseUrl,
    reasoning: false,
    input: target.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192
  }
  // ambient-only auth 仅满足 createProvider 的必填结构；真实密钥每次请求显式传入
  const provider = createProvider({
    id: 'amadeus',
    name: 'Amadeus LLM',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Amadeus API key',
        resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined)
      }
    },
    models: [model],
    api: openAICompletionsApi()
  })
  const models = createModels()
  models.setProvider(provider)
  const entry: LlmEntry = { models, model }
  cache.set(key, entry)
  return entry
}

/** proxy 配置下的 fetch（undici ProxyAgent；Node 内置 fetch 与 npm undici 不配对） */
export function proxyFetch(proxy: string): typeof globalThis.fetch {
  const agent = new ProxyAgent(proxy)
  const f = (input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...(init ?? {}), dispatcher: agent })
  return f as unknown as typeof globalThis.fetch
}

/** 流式补全：只产出文本增量（text_delta 事件） */
export async function* streamText(
  target: LlmTarget,
  context: Context,
  options?: StreamOptions
): AsyncGenerator<string> {
  const { models, model } = getLlm(target)
  const stream = models.stream(model, context, {
    apiKey: target.apiKey,
    signal: options?.signal,
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    ...(target.proxy ? { fetch: proxyFetch(target.proxy) } : {})
  })
  for await (const event of stream) {
    if (event.type === 'text_delta') yield event.delta
  }
}

/** 非流式补全（标题生成等小任务） */
export async function completeText(
  target: LlmTarget,
  context: Context,
  options?: StreamOptions
): Promise<string> {
  let out = ''
  for await (const delta of streamText(target, context, options)) out += delta
  return out
}

/**
 * 为 pi-agent-core Agent 构造 streamFn：绑定目标模型，逐请求注入
 * apiKey / temperature / maxTokens / 代理 fetch。Agent 循环每次 LLM 调用
 * 都会携带 context.tools 与 options.signal（回合 abort），这里透传即可。
 */
export function createAgentStreamFn(target: LlmTarget, opts?: StreamOptions): StreamFn {
  const { models } = getLlm(target)
  return (model, context, options) =>
    models.stream(model, context, {
      ...options,
      apiKey: target.apiKey,
      temperature: opts?.temperature ?? options?.temperature,
      maxTokens: opts?.maxTokens ?? options?.maxTokens,
      ...(target.proxy ? { fetch: proxyFetch(target.proxy) } : {})
    })
}

/** 把中文消息历史转成 pi-ai Context 消息（v1：内容只拼中文，不进日文 tts_text） */
export function toContextMessages(
  history: { role: 'user' | 'assistant'; content: string; createdAt: number }[]
): Context['messages'] {
  return history.map((m) =>
    m.role === 'assistant' ? assistantHistoryMessage(m.content, m.createdAt) : {
      role: 'user' as const,
      content: m.content,
      timestamp: m.createdAt
    }
  )
}

/** 历史助手消息：pi-ai 的 AssistantMessage 要求完整元数据，这里填占位 */
function assistantHistoryMessage(content: string, timestamp: number): Context['messages'][number] {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'openai-completions',
    provider: 'amadeus',
    model: 'history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp
  }
}
