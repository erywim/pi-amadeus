import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { BrainConfig } from '../config.ts'
import type { Db } from '../db.ts'

/**
 * 模型调度的公共契约（PIAM-11 方案 A 的模型调度部分）。
 *
 * 这里是 llm.ts / conversation.ts / runtime 之间唯一的共享面：
 * - LlmTarget / StreamOptions 从 llm.ts 移入，llm.ts 继续 re-export，旧 import 不破；
 * - RoutePurpose 从 conversation.ts 移入，conversation.ts 继续 re-export；
 * - ModelRuntime 只描述「一次选定的模型 + 绑定它的流式入口」；
 * - ModelDispatcher 是「本回合该用哪个模型」的唯一决策入口。
 *
 * 约束：dispatcher 只按配置与数据库路由，绝不在这里或它的实现里
 * 运行时导入 llm.ts / conversation.ts / tools——否则调度层会把执行细节
 * 和调用方重新缠在一起，单次选择的边界再次失效。
 */
export interface LlmTarget {
  baseUrl: string
  apiKey: string
  model: string
  /** 模型是否支持图像输入（决定语音回合是否附加视觉帧） */
  vision: boolean
  /** LLM 请求的本地 HTTP 代理（空 = 直连） */
  proxy?: string
  /** 来源模型服务（多服务列表激活时）；回落内置配置时为空 */
  providerId?: string
  providerName?: string
  /** 思考级别；off/未设 = 不请求思考（旧行为） */
  thinkingLevel?: ThinkingLevel
  /** 上下文窗口（token）；缺省 128k。pi 用它裁剪输出上限，避免输入+输出超窗 */
  contextWindow?: number
  /** 单次回复输出上限（token）；缺省 8192 */
  maxTokens?: number
}

export interface StreamOptions {
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  /** 思考级别；不传时用 target 上的配置 */
  thinkingLevel?: ThinkingLevel | 'off'
}

/** 路由组：标签匹配 + 未冷却 + 未超每日配额 */
export type RoutePurpose = 'chat' | 'vision' | 'summary' | 'memory'

/** 选中模型后的执行入口：模型元数据与绑定该目标的 streamFn */
export interface ModelRuntime {
  model: Model<Api>
  streamFn: StreamFn
}

/** 调度器的可选项：model 只覆盖本回合使用的模型 id，不写回用户配置 */
export interface ModelDispatchOptions {
  model?: string
}

/**
 * 本回合该用哪个模型：cfg / db / userId / purpose 是既有签名，
 * options.model 允许调用方指定模型 id（仍由调度器按目标执行）。
 */
export type ModelDispatcher = (
  cfg: BrainConfig,
  db: Db,
  userId: string,
  purpose?: RoutePurpose,
  options?: ModelDispatchOptions
) => Promise<LlmTarget>
