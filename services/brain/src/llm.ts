import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Context, Model, MutableModels } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { validateModelRuntimeOptions } from '@pi-amadeus/shared'
import { assertContextBudget, CONTEXT_TOO_LONG_PREFIX } from './contextBudget.ts'
import type { LlmTarget, ModelRuntime, StreamOptions } from './runtime/contracts.ts'

// 契约从 runtime/contracts.ts 移入；继续 re-export，保持既有 import 路径可用。
export type { LlmTarget, ModelRuntime, StreamOptions } from './runtime/contracts.ts'
export { supportsVision } from './runtime/model-capabilities.ts'

export const OUTPUT_LIMIT_ERROR = '回复被输出上限截断了。请调高「输出上限」、降低/关闭思考模式，或核对「上下文窗口」是否填得太小。'

/** 请求参数/输出预算问题不是服务故障；保留鉴权、连接等真实故障的冷却行为。 */
export function shouldCooldownProvider(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message !== OUTPUT_LIMIT_ERROR && !message.startsWith(CONTEXT_TOO_LONG_PREFIX) && !/^400\b/.test(message)
}

/**
 * pi-ai 接入层：把用户配置（baseUrl/apiKey/model）映射为一个
 * OpenAI 兼容自定义 provider，统一走 pi-ai 的流式管线。
 * 按 (baseUrl, model, vision, 窗口/上限) 缓存入口；apiKey/proxy 逐请求传入
 * （支持每用户独立密钥与独立代理）。
 */
/** 缺省上下文窗口与输出上限（保持与旧行为一致） */
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 8192

interface LlmEntry {
  models: MutableModels
  model: Model<'openai-completions'>
}

const cache = new Map<string, LlmEntry>()

export function getLlm(target: LlmTarget): LlmEntry {
  const error = validateModelRuntimeOptions(target)
  if (error) throw new Error(error)
  const baseUrl = target.baseUrl.replace(/\/+$/, '')
  const contextWindow = target.contextWindow && target.contextWindow > 0 ? target.contextWindow : DEFAULT_CONTEXT_WINDOW
  const maxTokens = target.maxTokens && target.maxTokens > 0 ? target.maxTokens : DEFAULT_MAX_TOKENS
  // 思考能力只影响请求参数，不影响客户端构造，但窗口/上限会进 Model 元数据
  const key = `${baseUrl}|${target.model}|${target.vision}|${contextWindow}|${maxTokens}`
  const hit = cache.get(key)
  if (hit) return hit

  const model: Model<'openai-completions'> = {
    id: target.model,
    name: target.model,
    api: 'openai-completions',
    provider: 'amadeus',
    baseUrl,
    /**
     * pi-ai 用 model.reasoning 决定是否把 thinkingLevel 映射成供应商参数
     * （reasoning_effort / thinking.type / enable_thinking…）。
     * 用户没设思考级别时仍标记为 true：级别为 off 时 pi 不会发任何思考参数，
     * 与旧行为一致；否则「想开思考却没有开关」永远打不开。
     */
    reasoning: true,
    /**
     * 声明每个档位映射到同名供应商值：
     * - 不声明时 pi 会把 xhigh/max 静默降级成 high——用户选了「极高」却发「高」，
     *   等于偷偷改配置。
     * - off 故意不声明：off 时不该给供应商发任何思考参数（发 reasoning_effort:"off"
     *   会被拒），不声明正好让 pi 什么都不发。
     */
    thinkingLevelMap: {
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    },
    input: target.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens
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

/**
 * 流式补全：产出文本增量；onUsage 在 done 事件时给出本次调用的用量，
 * onThinking 逐条给出模型真实返回的思考增量（未开思考/供应商不返回时不会调用）。
 *
 * 思考级别必须走 streamSimple：pi 的 SimpleStreamOptions.reasoning 才会被
 * 映射成供应商参数（reasoning_effort / thinking / enable_thinking…）；
 * 直接 stream() 只认 reasoningEffort 这种底层字段，传 thinkingLevel 会被丢掉；
 * 而且只有 streamSimple 会用 model.contextWindow 把输出上限裁到窗口内。
 * 所以统一走 streamSimple：级别为 off 时不传 reasoning，思考参数一个都不发。
 */
export async function* streamText(
  target: LlmTarget,
  context: Context,
  options?: StreamOptions,
  onUsage?: (usage: { input: number; output: number; total: number }) => void,
  onThinking?: (delta: string) => void
): AsyncGenerator<string> {
  const error = validateModelRuntimeOptions(options ?? {})
  if (error) throw new Error(error)
  const { models, model } = getLlm(target)
  assertContextBudget(context, model.contextWindow)
  const reasoning = options?.thinkingLevel ?? target.thinkingLevel
  const stream = models.streamSimple(model, context, {
    apiKey: target.apiKey,
    signal: options?.signal,
    temperature: options?.temperature,
    // stream() 不会回落到 model.maxTokens：必须显式给出，否则上限形同虚设
    maxTokens: options?.maxTokens ?? model.maxTokens,
    reasoning: reasoning === 'off' ? undefined : reasoning,
    ...(target.proxy ? { fetch: proxyFetch(target.proxy) } : {})
  })
  for await (const event of stream) {
    if (event.type === 'text_delta') yield event.delta
    else if (event.type === 'thinking_delta') onThinking?.(event.delta)
    else if (event.type === 'error') {
      // pi-ai 将鉴权/上游失败编码成事件；必须从生成中转为失败，不能冒充空回复。
      throw new Error(event.error.errorMessage || (event.reason === 'aborted' ? 'LLM 请求已中止' : 'LLM 请求失败'))
    } else if (event.type === 'done') {
      onUsage?.({
        input: event.message.usage.input ?? 0,
        output: event.message.usage.output ?? 0,
        total: event.message.usage.totalTokens ?? 0
      })
      // 即使已有正文，length 也代表未完成；先回传真实用量，再告知调用方截断。
      if (event.reason === 'length') throw new Error(OUTPUT_LIMIT_ERROR)
    }
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
  const error = validateModelRuntimeOptions(opts ?? {})
  if (error) throw new Error(error)
  const { models } = getLlm(target)
  return (model, context, options) => {
    assertContextBudget(context, model.contextWindow)
    const base = {
      ...options,
      apiKey: target.apiKey,
      temperature: opts?.temperature ?? options?.temperature,
      // 同上：缺失时补上模型配置的上限，保证「输出上限」设置真的生效
      maxTokens: opts?.maxTokens ?? options?.maxTokens ?? model.maxTokens,
      ...(target.proxy ? { fetch: proxyFetch(target.proxy) } : {})
    }
    // 显式调用参数（含 off）优先于 Agent 状态，再回落模型配置；否则 off 会被继承值覆盖。
    // streamSimple 负责供应商协议映射与上下文窗口内的输出裁剪。
    const reasoning = opts?.thinkingLevel ?? options?.reasoning ?? target.thinkingLevel
    const error = validateModelRuntimeOptions({ ...base, thinkingLevel: reasoning })
    if (error) throw new Error(error)
    return models.streamSimple(model, context, {
      ...base,
      reasoning: reasoning === 'off' ? undefined : reasoning
    })
  }
}

/**
 * 把「本回合选定的目标」封装成执行入口：模型元数据 + 绑定该目标的 streamFn。
 * 协议映射、鉴权校验、上下文预算与错误语义全部沿用 getLlm /
 * createAgentStreamFn 的既有行为，createModelRuntime 只做组合。
 */
export function createModelRuntime(target: LlmTarget, opts?: StreamOptions): ModelRuntime {
  const { model } = getLlm(target)
  return { model, streamFn: createAgentStreamFn(target, opts) }
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
