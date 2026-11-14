import { randomUUID } from 'node:crypto'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentMessage, AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import type { Channel, ResponseGuardConfig, SseErrorCode, SseEvent, TurnMode } from '@pi-amadeus/shared'
import { AsyncQueue } from './bilingual.ts'
import type { BrainConfig } from './config.ts'
import { compactionLevelOf, prepareTurn } from './conversation.ts'
import { estimateAgentMessagesTokens, microCompactMessages } from './context/micro.ts'
import { INPUT_BUDGET_TOKENS, policyOf } from './context/limits.ts'
import type { Db } from './db.ts'
import { createAgentStreamFn, getLlm, type LlmTarget } from './llm.ts'
import { mcpManager } from './mcp/manager.ts'
import { disabledSkillNames } from './plugins/registry.ts'
import { createUseSkillTool, loadSkillBundle, skillsPrompt } from './skills/index.ts'
import {
  deniedMessage,
  rejectAllForTurn,
  requestBashConfirm,
  requestToolConfirm,
  ToolDeniedError,
  type ToolConfirmRequest
} from './tools/confirm.ts'
import { BLOCK_PREFIX, blockReason, checkBashSafety } from './tools/safety.ts'
import { buildToolRegistry } from './tools/index.ts'
import { workflowPrompt } from './workflow/prompt.ts'
import { createWorkflowTool } from './workflow/tool.ts'
import { workflowLevelOf } from './workflow/types.ts'
import { DesktopBridge, registerDesktopBridge, unregisterDesktopBridge } from './tools/desktop-bridge.ts'

/**
 * 工具版回合核心（chat 与 feishu 共用）：prepareTurn 复用 →
 * pi-agent-core Agent 跑完整工具循环（LLM 流 → 工具提取/执行 →
 * 结果回流再提示，直到纯文本收尾）→ AgentEvent 映射为 SSE 工具事件。
 * 语音回合不走此路径（runVoiceTurn 保持无工具）。
 */

export interface AgentTurnOptions {
  cfg: BrainConfig
  db: Db
  userId: string
  sessionId: string
  channel: Channel
  mode: TurnMode
  content: string
  signal?: AbortSignal
  /** LLM 采样参数（缺省不传 = 供应商默认） */
  temperature?: number
  maxTokens?: number
  /** 是否把本次用户消息写入会话（重新生成传 false，活动世界线末端已有那条消息） */
  appendUserMessage?: boolean
  /** 重新生成时要排除的历史消息 id（旧助手回答） */
  omitMessageId?: string
  /** 后台工作台任务隔离人格/记忆；普通聊天保持原路径。 */
  isolated?: boolean
  instructions?: string
  model?: string
  cwd?: string
  /** 本次用户消息的附件（图片 / 语音 / 文件） */
  attachments?: import('./media.ts').SavedAttachment[]
  /** 从指定父消息之后分叉（编辑后重发用；null = 根分支） */
  branchParentId?: string | null
}

export interface AgentTurnUsage {
  input: number
  output: number
  total: number
}

export interface AgentTurnResult {
  full: string
  target: LlmTarget
  /** 本回合所有 LLM 调用的 token 用量（工具循环会多次调用，逐次累加） */
  usage: AgentTurnUsage
  /** 本回合实际执行的工具次数与工具名（看板统计用） */
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

/** 工具结果文本的 UI 上限（超出截断） */
const RESULT_LIMIT = 4000
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

/** content 块拼文本（ImageContent 忽略——工具结果 v1 只出文本） */
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

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（已截断）`
}

export async function* runAgentTurn(
  opts: AgentTurnOptions
): AsyncGenerator<SseEvent, AgentTurnResult> {
  const turnId = randomUUID()

  const prepared = await prepareTurn({
    cfg: opts.cfg,
    db: opts.db,
    userId: opts.userId,
    sessionId: opts.sessionId,
    channel: opts.channel,
    mode: opts.mode,
    content: opts.content,
    signal: opts.signal,
    appendUserMessage: opts.appendUserMessage,
    omitMessageId: opts.omitMessageId,
    isolated: opts.isolated,
    attachments: opts.attachments,
    branchParentId: opts.branchParentId
  })
  // 任务级覆盖只作用于本次执行，不回写用户模型或工作目录配置。
  if (opts.model) prepared.target = { ...prepared.target, model: opts.model }
  if (opts.instructions) prepared.systemPrompt += `\n\n任务角色说明：\n${opts.instructions}`
  if (opts.signal?.aborted) {
    return { full: '', target: prepared.target, usage: { input: 0, output: 0, total: 0 }, toolCalls: 0, toolNames: [] }
  }

  const toolsEnabled = prepared.userConfig?.tools?.enabled !== false
  const responseGuard = responseGuardOf(prepared.userConfig)
  const queue = new AsyncQueue<SseEvent>()
  // 本回合开始前发生了上下文压缩：先上屏一条提示（在正文 delta 之前）
  if (prepared.compaction) {
    queue.push({
      type: 'compact',
      turnId,
      summarizedMessages: prepared.compaction.summarizedMessages,
      tokensBefore: prepared.compaction.tokensBefore,
      tokensAfter: prepared.compaction.tokensAfter
    })
  }
  let full = ''
  // 指标：工具循环里每次 LLM 调用都会带 usage，逐次累加才是本回合真实消耗
  const usage: AgentTurnUsage = { input: 0, output: 0, total: 0 }
  const toolNames: string[] = []
  let reservedToolCalls = 0
  let toolTurns = 0
  let lastToolTurn: unknown = null
  let lastToolSignature = ''
  let repeatedToolCalls = 0
  let lastBlockedReason = ''
  let consecutiveBlocked = 0
  let guardError: AgentTurnError | null = null

  // bash 确认握手：登记 pending → tool_confirm 事件上屏 → execute 内 await 放行
  const confirmRequest = async (toolCallId: string, command: string): Promise<boolean> => {
    // 审批必须显示完整可执行内容；过大命令直接拒绝，不能截断后让用户批准隐藏前缀。
    if (Buffer.byteLength(command, 'utf8') > 16 * 1024) {
      throw new ToolDeniedError('blocked', blockReason('命令超过 16 KiB，请拆分为可完整审阅的命令'))
    }
    const { promise, expiresAt } = requestBashConfirm({
      turnId,
      toolCallId,
      command,
      timeoutMs: opts.cfg.tools.confirmTimeoutMs,
      signal: opts.signal
    })
    queue.push({
      type: 'tool_confirm',
      turnId,
      toolCallId,
      toolName: 'bash',
      label: '执行命令',
      kind: 'bash',
      args: { command },
      expiresAt
    })
    return promise
  }

  const confirmMcpRequest = async (
    request: {
      toolCallId: string
      serverId: string
      serverName: string
      toolName: string
      args: Record<string, unknown>
    },
    signal?: AbortSignal
  ): Promise<boolean> => {
    const input: ToolConfirmRequest = {
      turnId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      label: `${request.serverName} · ${request.toolName}`,
      kind: 'computer',
      args: request.args,
      timeoutMs: opts.cfg.tools.confirmTimeoutMs,
      signal: signal ?? opts.signal
    }
    const { promise, expiresAt } = requestToolConfirm(input)
    queue.push({
      type: 'tool_confirm',
      turnId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      label: input.label,
      kind: input.kind,
      args: request.args,
      expiresAt
    })
    return promise
  }

  const desktopBridge =
    toolsEnabled && prepared.userConfig?.computerUse?.enabled === true && opts.channel === 'desktop' && prepared.target.vision
      ? new DesktopBridge({
          turnId,
          signal: opts.signal,
          timeoutMs: opts.cfg.tools.computerTimeoutMs,
          push: (event) => queue.push(event)
        })
      : undefined
  const tools = toolsEnabled
    ? buildToolRegistry({
        cfg: opts.cwd ? { ...opts.cfg, tools: { ...opts.cfg.tools, bashCwd: opts.cwd } } : opts.cfg,
        channel: opts.channel,
        target: prepared.target,
        confirmRequest,
        desktopBridge
      })
    : []

  // skill：文件形式、每回合热加载；启用列表注入 systemPrompt + use_skill 工具。
  // 插件中心关掉的 skill 与文件状态表里的停用取并集，两处入口效果一致
  const disabledSkills = toolsEnabled ? await disabledSkillNames(opts.db) : new Set<string>()
  const skillBundle = toolsEnabled ? await loadSkillBundle(opts.cfg, disabledSkills) : { skills: [] }
  if (skillBundle.skills.length > 0) {
    tools.push(createUseSkillTool(skillBundle.skills))
  }
  // MCP 插件工具：Computer Use 仅在桌面、视觉模型和用户显式开关同时满足时暴露。
  if (toolsEnabled) {
    tools.push(
      ...mcpManager.listAgentTools({
        allowComputerUse:
          opts.channel === 'desktop' &&
          prepared.target.vision &&
          prepared.userConfig?.computerUse?.enabled === true,
        requestConfirm: confirmMcpRequest
      })
    )
  }
  // 动态工作流：档位开启才注册工具（关=LLM 完全看不到这个工具）；随档位注入编排手册
  const workflowLevel = workflowLevelOf(prepared.userConfig)
  if (toolsEnabled && workflowLevel !== 'off') {
    tools.push(createWorkflowTool({ cfg: opts.cfg, target: prepared.target, level: workflowLevel }))
  }
  if (desktopBridge) registerDesktopBridge(desktopBridge)
  const labelOf = new Map(tools.map((t) => [t.name, t.label]))

  // 安全第一道：pi 原生 beforeToolCall 权限钩子——高危 bash 命令直接拦截
  // （不弹确认卡），isError 结果回流 LLM
  const beforeToolCall = async (
    context: BeforeToolCallContext
  ): Promise<{ block: boolean; reason?: string } | undefined> => {
    if (context.toolCall.name !== 'bash') return undefined
    const command = String((context.toolCall.arguments as Record<string, unknown>)?.command ?? '')
    const check = checkBashSafety(command)
    if (!check.allowed) return { block: true, reason: blockReason(check.reason) }
    return undefined
  }

  // 回合内微压缩（对应 Claude Code 的 microCompact）：工具循环把上下文撑大时，
  // 只把较早的工具结果换成占位说明，不动用户消息与助手回复。
  // 契约要求 transformContext 绝不抛错——任何异常都原样返回，宁可 context 大一点。
  const microPolicy = policyOf(compactionLevelOf(prepared.userConfig))
  const transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (!microPolicy) return messages
    try {
      const tokens = estimateAgentMessagesTokens(messages)
      if (tokens <= INPUT_BUDGET_TOKENS * microPolicy.microTriggerRatio) return messages
      return microCompactMessages(messages, {
        keepRecentToolResults: microPolicy.keepRecentToolResults
      })
    } catch (error) {
      console.warn('[compact] 回合内微压缩失败，保留原上下文：', error instanceof Error ? error.message : error)
      return messages
    }
  }

  const beforeToolCallWithGuard = async (
    context: BeforeToolCallContext
  ): Promise<{ block: boolean; reason?: string; terminate?: boolean } | undefined> => {
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
    return beforeToolCall(context)
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

  const agent = new Agent({
    initialState: {
      // 工具总开关关闭时工作流也不可用：手册一并省略，避免模型调用不存在的工具
      systemPrompt:
        prepared.systemPrompt +
        skillsPrompt(skillBundle.skills) +
        workflowPrompt(toolsEnabled ? workflowLevel : 'off'),
      model: getLlm(prepared.target).model,
      // 历史不含当前用户消息——prompt() 会自行 append，否则上下文里出现两次
      messages: prepared.messages.slice(0, -1),
      tools
    },
    streamFn: createAgentStreamFn(prepared.target, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens
    }),
    beforeToolCall: beforeToolCallWithGuard,
    afterToolCall,
    transformContext
  })

  const unsubscribe = agent.subscribe((event: AgentEvent): void => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          const delta = event.assistantMessageEvent.delta
          full += delta
          queue.push({ type: 'delta', delta })
        }
        return
      case 'message_end':
        // 每条助手消息结束都带 usage；工具循环里的每次调用都要计入本回合
        if (event.message.role === 'assistant' && event.message.usage) {
          usage.input += event.message.usage.input ?? 0
          usage.output += event.message.usage.output ?? 0
          usage.total += event.message.usage.totalTokens ?? 0
        }
        return
      case 'tool_execution_start':
        queue.push({
          type: 'tool_start',
          turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          label: labelOf.get(event.toolName) ?? event.toolName,
          args: (event.args ?? {}) as Record<string, unknown>
        })
        return
      case 'tool_execution_update':
        queue.push({
          type: 'tool_update',
          turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partial: truncate(textOf(event.partialResult?.content), RESULT_LIMIT)
        })
        return
      case 'tool_execution_end': {
        toolNames.push(event.toolName)
        const resultText = textOf(event.result?.content)
        const details: Record<string, unknown> = { ...(event.result?.details ?? {}) }
        // bash 拒绝/拦截：execute 抛出的消息是唯一定位来源，回推 deniedReason
        if (event.isError && event.toolName === 'bash') {
          if (resultText.startsWith(BLOCK_PREFIX)) details.deniedReason = 'blocked'
          else if (resultText.includes(deniedMessage('user_denied'))) details.deniedReason = 'user_denied'
          else if (resultText.includes(deniedMessage('timeout'))) details.deniedReason = 'timeout'
          else if (resultText.includes(deniedMessage('aborted'))) details.deniedReason = 'aborted'
        }
        queue.push({
          type: 'tool_end',
          turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          result: truncate(resultText, RESULT_LIMIT),
          details
        })
        return
      }
      // agent_start / turn_start / message_* / turn_end / agent_end：内部事件，不上屏
    }
  })

  const onAbort = (): void => agent.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const lastUser = prepared.messages[prepared.messages.length - 1]
  if (!lastUser) throw new Error('LLM 上下文为空')

  try {
    // Agent 契约不抛（失败编码进事件流），防御性兜底；close 保证
    // done/error 之前队列事件全部排空
    const run = agent.prompt(lastUser).catch(() => {})
    void run.finally(() => queue.close())
    for await (const ev of queue) yield ev
    await run
  } finally {
    unsubscribe()
    opts.signal?.removeEventListener('abort', onAbort)
    rejectAllForTurn(turnId)
    if (desktopBridge) {
      unregisterDesktopBridge(turnId)
    }
  }

  if (opts.signal?.aborted) {
    return { full: '', target: prepared.target, usage, toolCalls: toolNames.length, toolNames }
  }
  if (guardError) throw guardError
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
  if (!full) throw new Error('LLM 返回为空')
  // totalTokens 缺失时用输入+输出兜底（部分兼容端点不返回 total）
  if (usage.total === 0) usage.total = usage.input + usage.output
  return { full, target: prepared.target, usage, toolCalls: toolNames.length, toolNames }
}
