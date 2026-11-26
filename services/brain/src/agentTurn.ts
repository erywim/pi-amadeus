import { randomUUID } from 'node:crypto'
import type { AfterToolCallContext, AfterToolCallResult, AgentMessage, BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type { Channel, ResponseGuardConfig, SseErrorCode, SseEvent, TurnMode } from '@pi-amadeus/shared'
import { AsyncQueue } from './bilingual.ts'
import type { BrainConfig } from './config.ts'
import { compactionLevelOf, prepareTurn } from './conversation.ts'
import { estimateAgentMessagesTokens, microCompactMessages } from './context/micro.ts'
import { INPUT_BUDGET_TOKENS, policyOf } from './context/limits.ts'
import type { Db } from './db.ts'
import { createModelRuntime } from './llm.ts'
import type { LlmTarget } from './runtime/contracts.ts'
import { disabledSkillNames } from './plugins/registry.ts'
import { loadSkillBundle } from './skills/index.ts'
import { executeAgent } from './turn/agent-executor.ts'
import type { AgentExecutionResult, TurnEvent, TurnUsage } from './turn/contracts.ts'
import { createToolChain, type ToolChain } from './turn/tool-chain.ts'
import { initialTurnState, isTurnFinal, transitionTurn } from './turn/state-machine.ts'
import { toSseEvent } from './turn/sse-adapter.ts'
import { workflowPrompt } from './workflow/prompt.ts'
import { createWorkflowTool } from './workflow/tool.ts'
import { workflowLevelOf } from './workflow/types.ts'

/** 兼容入口/组合根：准备上下文、连接模型/工具/状态，最终映射为既有 SSE。 */
export interface AgentTurnOptions {
  cfg: BrainConfig
  db: Db
  userId: string
  sessionId: string
  channel: Channel
  mode: TurnMode
  content: string
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  /** 重新生成已有用户消息，不再追加。 */
  appendUserMessage?: boolean
  omitMessageId?: string
  /** 后台任务隔离人格/记忆，不回写用户模型与工作目录。 */
  isolated?: boolean
  instructions?: string
  model?: string
  cwd?: string
  attachments?: import('./media.ts').SavedAttachment[]
  branchParentId?: string | null
}

export type AgentTurnUsage = TurnUsage

export interface AgentTurnResult {
  full: string
  target: LlmTarget
  usage: AgentTurnUsage
  toolCalls: number
  toolNames: string[]
  userMessageId?: string
  changedFiles?: Array<{ path: string; status: string }>
  thinking?: string
}

export class AgentTurnError extends Error {
  readonly code: SseErrorCode
  readonly recoverability: 'retry' | 'continue' | 'edit' | 'none'
  readonly details?: { attempt?: number; limit?: number; toolName?: string; turnCount?: number }

  constructor(
    message: string,
    code: SseErrorCode,
    recoverability: 'retry' | 'continue' | 'edit' | 'none',
    details?: { attempt?: number; limit?: number; toolName?: string; turnCount?: number }
  ) {
    super(message)
    this.name = 'AgentTurnError'
    this.code = code
    this.recoverability = recoverability
    this.details = details
  }
}

const DEFAULT_RESPONSE_GUARD: Required<ResponseGuardConfig> = {
  errorChecks: true,
  maxTurns: 32,
  maxToolCalls: 96,
  maxRepeatedToolCalls: 8,
  maxConsecutiveBlocked: 3
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function responseGuardOf(config: import('@pi-amadeus/shared').UserConfig | null): Required<ResponseGuardConfig> {
  const input = config?.responseGuard ?? {}
  return {
    errorChecks: input.errorChecks !== false,
    maxTurns: positiveInt(input.maxTurns, DEFAULT_RESPONSE_GUARD.maxTurns),
    maxToolCalls: positiveInt(input.maxToolCalls, DEFAULT_RESPONSE_GUARD.maxToolCalls),
    maxRepeatedToolCalls: positiveInt(input.maxRepeatedToolCalls, DEFAULT_RESPONSE_GUARD.maxRepeatedToolCalls),
    maxConsecutiveBlocked: positiveInt(input.maxConsecutiveBlocked, DEFAULT_RESPONSE_GUARD.maxConsecutiveBlocked)
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

function toolSignature(toolName: string, args: unknown, result: unknown, isError: boolean): string {
  return `${toolName}\nargs=${stableJson(args ?? {})}\nresult=${stableJson(result ?? null)}\nerror=${isError ? '1' : '0'}`
}

function blockedReason(toolName: string, result: string, details: Record<string, unknown>): string | null {
  const denied = typeof details.deniedReason === 'string' ? details.deniedReason : ''
  if (denied) return `${toolName}:${denied}`
  if (!result) return null
  if (/拦截|拒绝|blocked|denied|permission|安全策略/i.test(result)) return `${toolName}:${result.slice(0, 160)}`
  return null
}

export interface AgentTurnErrorInfo {
  code: SseErrorCode
  recoverability: 'retry' | 'continue' | 'edit' | 'none'
  details?: { attempt?: number; limit?: number; toolName?: string; turnCount?: number }
}

export function agentTurnErrorInfo(error: unknown): AgentTurnErrorInfo {
  if (error instanceof AgentTurnError) {
    return { code: error.code, recoverability: error.recoverability, ...(error.details ? { details: error.details } : {}) }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/输出上限截断|output token limit|maximum output/i.test(message)) return { code: 'output_limit', recoverability: 'retry' }
  if (/上下文过长|context.{0,20}(window|limit)|prompt.{0,20}too long/i.test(message)) return { code: 'context_limit', recoverability: 'edit' }
  if (/aborted|中止|取消|已停止/i.test(message)) return { code: 'aborted', recoverability: 'none' }
  if (/429|529|rate limit|retry/i.test(message)) return { code: 'provider_retry_exhausted', recoverability: 'retry' }
  if (/工具|tool/i.test(message)) return { code: 'tool_execution_failed', recoverability: 'continue' }
  return { code: 'provider_error', recoverability: 'retry' }
}

/** content 块拼文本（ImageContent 忽略——护栏只比较文本结果） */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const b = block as { type?: string; text?: unknown }
      return b.type === 'text' ? String(b.text ?? '') : ''
    })
    .join('')
}

export async function* runAgentTurn(opts: AgentTurnOptions): AsyncGenerator<SseEvent, AgentTurnResult> {
  const turnId = randomUUID()
  const controller = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
  let state = initialTurnState()
  const queue = new AsyncQueue<SseEvent>()
  let chain: ToolChain | undefined
  let run: Promise<void> | undefined
  let result: AgentExecutionResult | undefined
  let failure: unknown
  const labels = new Map<string, string>()
  const onAbort = (): void => {
    // 准备/执行/等待审批 → cancelled；先固定终态，再让工具清理拒绝等待项。
    state = transitionTurn(state, { type: 'cancel' })
    chain?.dispose()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const emit = (event: TurnEvent): void => {
    if (signal.aborted || isTurnFinal(state)) return
    if (event.type === 'tool_confirm' || event.type === 'computer_request') {
      state = transitionTurn(state, { type: 'approval_requested', toolCallId: event.toolCallId })
    }
    if (event.type === 'approval_settled' || event.type === 'tool_end') {
      state = transitionTurn(state, { type: 'approval_settled', toolCallId: event.toolCallId })
    }
    const outgoing = toSseEvent(chain?.decorateEvent(event) ?? event, turnId, labels)
    if (outgoing) queue.push(outgoing)
  }
  try {
    const prepared = await prepareTurn({ ...opts, signal })
    const empty = (): AgentTurnResult => ({ full: '', target: prepared.target,
      usage: { input: 0, output: 0, total: 0 }, toolCalls: 0, toolNames: [], userMessageId: prepared.userMessageId })
    if (signal.aborted) return empty()
    if (opts.instructions) prepared.systemPrompt += `\n\n任务角色说明：\n${opts.instructions}`
    // 压缩提示先于正文和工具事件，保留原 SSE 顺序。
    if (prepared.compaction) queue.push({ type: 'compact', turnId,
      summarizedMessages: prepared.compaction.summarizedMessages,
      tokensBefore: prepared.compaction.tokensBefore, tokensAfter: prepared.compaction.tokensAfter })
    const enabled = prepared.userConfig?.tools?.enabled !== false
    const disabled = enabled ? await disabledSkillNames(opts.db) : new Set<string>()
    const bundle = enabled ? await loadSkillBundle(opts.cfg, disabled) : { skills: [] }
    if (signal.aborted) return empty()
    const workflowLevel = enabled ? workflowLevelOf(prepared.userConfig) : 'off'
    // 错误检查与循环预算是回合级硬保护：不依赖工具链内部状态，取消/审批也不清零。
    const responseGuard = responseGuardOf(prepared.userConfig)
    let reservedToolCalls = 0
    let toolTurns = 0
    let lastToolTurn: unknown = null
    let lastToolSignature = ''
    let repeatedToolCalls = 0
    let lastBlockedReason = ''
    let consecutiveBlocked = 0
    let guardError: AgentTurnError | null = null
    const toolChain = createToolChain({
      cfg: { tools: opts.cwd ? { ...opts.cfg.tools, bashCwd: opts.cwd } : opts.cfg.tools },
      turnId, channel: opts.channel, capabilities: { vision: prepared.target.vision, proxy: prepared.target.proxy },
      enabled, computerEnabled: prepared.userConfig?.computerUse?.enabled, signal, skills: bundle.skills,
      extraTools: workflowLevel === 'off' ? [] : [createWorkflowTool({ cfg: opts.cfg, target: prepared.target, level: workflowLevel })],
      promptAdditions: workflowPrompt(workflowLevel), onEvent: emit
    })
    chain = toolChain
    for (const tool of toolChain.tools) labels.set(tool.name, tool.label)
    // 预算在工具执行前预占：审批等待中的调用也计入上限，避免并行批次绕过硬限制。
    const beforeToolCallWithGuard = async (
      context: BeforeToolCallContext
    ): Promise<BeforeToolCallResult | undefined> => {
      const remaining = responseGuard.maxToolCalls - reservedToolCalls
      if (remaining <= 0) {
        guardError = new AgentTurnError(
          `已停止：本回合工具调用达到上限（${responseGuard.maxToolCalls} 次）。请检查任务是否陷入循环后重试。`,
          'max_tool_calls',
          'retry',
          { limit: responseGuard.maxToolCalls }
        )
        // 预算是硬保护，即使用户关闭重复检查也不能无限执行工具。
        return { block: true, reason: guardError.message, terminate: true }
      }
      reservedToolCalls += 1
      return toolChain.beforeToolCall?.(context)
    }
    const afterToolCall = async (context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
      const turnKey = context.assistantMessage
      if (turnKey !== lastToolTurn) {
        lastToolTurn = turnKey
        toolTurns += 1
        if (toolTurns >= responseGuard.maxTurns) {
          guardError = new AgentTurnError(
            `已停止：本回合工具循环达到上限（${responseGuard.maxTurns} 轮）。请检查任务是否陷入循环后重试。`,
            'max_turns',
            'retry',
            { limit: responseGuard.maxTurns, turnCount: toolTurns }
          )
          return { terminate: true }
        }
      }
      const resultText = textOf(context.result.content)
      const details = (context.result.details && typeof context.result.details === 'object' ? context.result.details : {}) as Record<string, unknown>
      const signature = toolSignature(context.toolCall.name, context.args, resultText, context.isError)
      if (signature === lastToolSignature) repeatedToolCalls += 1
      else {
        lastToolSignature = signature
        repeatedToolCalls = 1
      }
      const blocked = blockedReason(context.toolCall.name, resultText, details)
      if (blocked === lastBlockedReason) consecutiveBlocked += 1
      else {
        lastBlockedReason = blocked ?? ''
        consecutiveBlocked = blocked ? 1 : 0
      }
      if (reservedToolCalls >= responseGuard.maxToolCalls) {
        guardError = new AgentTurnError(
          `已停止：本回合工具调用达到上限（${responseGuard.maxToolCalls} 次）。请检查任务是否陷入循环后重试。`,
          'max_tool_calls',
          'retry',
          { limit: responseGuard.maxToolCalls }
        )
        return { terminate: true }
      }
      if (responseGuard.errorChecks && repeatedToolCalls >= responseGuard.maxRepeatedToolCalls) {
        guardError = new AgentTurnError(
          `已停止：检测到工具 ${context.toolCall.name} 连续 ${repeatedToolCalls} 次产生完全相同的调用与结果，模型可能陷入重复。请告诉 Agent 下一步怎么做，或关闭“错误检查”。`,
          'repeated_blocked_action',
          'retry',
          { attempt: repeatedToolCalls, limit: responseGuard.maxRepeatedToolCalls, toolName: context.toolCall.name }
        )
        // 先保留这次结果，再阻止下一次模型请求；这样日志与 UI 仍能看到最后一次真实工具结果。
        return { terminate: true }
      }
      if (responseGuard.errorChecks && consecutiveBlocked >= responseGuard.maxConsecutiveBlocked) {
        guardError = new AgentTurnError(
          `已停止：工具 ${context.toolCall.name} 连续 ${consecutiveBlocked} 次被阻断或拒绝，需要用户介入。`,
          'repeated_blocked_action',
          'continue',
          { attempt: consecutiveBlocked, limit: responseGuard.maxConsecutiveBlocked, toolName: context.toolCall.name }
        )
        return { terminate: true }
      }
      return undefined
    }
    const microPolicy = policyOf(compactionLevelOf(prepared.userConfig))
    const transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
      if (!microPolicy) return messages
      try {
        if (estimateAgentMessagesTokens(messages) <= INPUT_BUDGET_TOKENS * microPolicy.microTriggerRatio) return messages
        return microCompactMessages(messages, { keepRecentToolResults: microPolicy.keepRecentToolResults })
      } catch (error) {
        console.warn('[compact] 回合内微压缩失败，保留原上下文：', error instanceof Error ? error.message : error)
        return messages
      }
    }
    // 准备完成 → running；执行器只拿选定模型/工具，不再调度或加载配置。
    state = transitionTurn(state, { type: 'start' })
    run = executeAgent({ runtime: createModelRuntime(prepared.target, { temperature: opts.temperature, maxTokens: opts.maxTokens }),
      systemPrompt: prepared.systemPrompt + toolChain.systemPromptAdditions, messages: prepared.messages,
      tools: toolChain.tools, beforeToolCall: beforeToolCallWithGuard, afterToolCall,
      transformContext, signal, onEvent: emit
    }).then((value) => { result = value }, (error: unknown) => { failure = error }).finally(() => queue.close())
    for await (const event of queue) {
      if (!signal.aborted) yield event
    }
    await run
    if (signal.aborted) return { ...empty(), usage: result?.usage ?? empty().usage,
      toolCalls: result?.toolNames.length ?? 0, toolNames: result?.toolNames ?? [] }
    if (failure) throw failure
    // 护栏是主动终止：执行器正常返回但本回合已有明确的失败原因，必须交给路由分类。
    if (guardError) throw guardError
    if (!result?.full) throw new Error('LLM 返回为空')
    state = transitionTurn(state, { type: 'complete' })
    if (state.status !== 'completed') throw new Error('回合结束时仍有未决审批')
    return { full: result.full, target: prepared.target, usage: result.usage,
      toolCalls: result.toolNames.length, toolNames: result.toolNames, userMessageId: prepared.userMessageId }
  } catch (error) {
    // 任意活动态 → failed；异常不伪装成空成功，交原路由输出 error。
    state = transitionTurn(state, { type: 'fail' })
    throw error
  } finally {
    // 消费者提前 return/取消/失败 → 停止 owned 执行并等待收尾，不能遗留模型请求或审批。
    controller.abort()
    chain?.dispose()
    await run
    signal.removeEventListener('abort', onAbort)
    queue.close()
  }
}
