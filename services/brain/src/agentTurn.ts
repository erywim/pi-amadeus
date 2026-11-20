import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Channel, SseEvent, TurnMode } from '@pi-amadeus/shared'
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
    chain = createToolChain({
      cfg: { tools: opts.cwd ? { ...opts.cfg.tools, bashCwd: opts.cwd } : opts.cfg.tools },
      turnId, channel: opts.channel, capabilities: { vision: prepared.target.vision, proxy: prepared.target.proxy },
      enabled, computerEnabled: prepared.userConfig?.computerUse?.enabled, signal, skills: bundle.skills,
      extraTools: workflowLevel === 'off' ? [] : [createWorkflowTool({ cfg: opts.cfg, target: prepared.target, level: workflowLevel })],
      promptAdditions: workflowPrompt(workflowLevel), onEvent: emit
    })
    for (const tool of chain.tools) labels.set(tool.name, tool.label)
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
      systemPrompt: prepared.systemPrompt + chain.systemPromptAdditions, messages: prepared.messages,
      tools: chain.tools, beforeToolCall: chain.beforeToolCall, transformContext, signal, onEvent: emit
    }).then((value) => { result = value }, (error: unknown) => { failure = error }).finally(() => queue.close())
    for await (const event of queue) {
      if (!signal.aborted) yield event
    }
    await run
    if (signal.aborted) return { ...empty(), usage: result?.usage ?? empty().usage,
      toolCalls: result?.toolNames.length ?? 0, toolNames: result?.toolNames ?? [] }
    if (failure) throw failure
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
