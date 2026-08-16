import { randomUUID } from 'node:crypto'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import type { Channel, SseEvent, TurnMode } from '@pi-amadeus/shared'
import { AsyncQueue } from './bilingual.ts'
import type { BrainConfig } from './config.ts'
import { prepareTurn } from './conversation.ts'
import type { Db } from './db.ts'
import { createAgentStreamFn, getLlm, type LlmTarget } from './llm.ts'
import { createUseSkillTool, loadSkillBundle, skillsPrompt } from './skills/index.ts'
import { deniedMessage, rejectAllForTurn, requestBashConfirm } from './tools/confirm.ts'
import { BLOCK_PREFIX, blockReason, checkBashSafety } from './tools/safety.ts'
import { buildToolRegistry } from './tools/index.ts'

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
}

export interface AgentTurnResult {
  full: string
  target: LlmTarget
}

/** 工具结果文本的 UI 上限（超出截断） */
const RESULT_LIMIT = 4000

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
    content: opts.content
  })
  if (opts.signal?.aborted) return { full: '', target: prepared.target }

  const toolsEnabled = prepared.userConfig?.tools?.enabled !== false
  const queue = new AsyncQueue<SseEvent>()
  let full = ''

  // bash 确认握手：登记 pending → tool_confirm 事件上屏 → execute 内 await 放行
  const confirmRequest = async (toolCallId: string, command: string): Promise<boolean> => {
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
      args: { command },
      expiresAt
    })
    return promise
  }

  const tools = toolsEnabled
    ? buildToolRegistry({
        cfg: opts.cfg,
        channel: opts.channel,
        target: prepared.target,
        confirmRequest
      })
    : []

  // skill：文件形式、每回合热加载；启用列表注入 systemPrompt + use_skill 工具
  const skillBundle = toolsEnabled ? await loadSkillBundle(opts.cfg) : { skills: [] }
  if (skillBundle.skills.length > 0) {
    tools.push(createUseSkillTool(skillBundle.skills))
  }
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

  const agent = new Agent({
    initialState: {
      systemPrompt: prepared.systemPrompt + skillsPrompt(skillBundle.skills),
      model: getLlm(prepared.target).model,
      // 历史不含当前用户消息——prompt() 会自行 append，否则上下文里出现两次
      messages: prepared.messages.slice(0, -1),
      tools
    },
    streamFn: createAgentStreamFn(prepared.target, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens
    }),
    beforeToolCall
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
  }

  if (opts.signal?.aborted) return { full: '', target: prepared.target }
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
  if (!full) throw new Error('LLM 返回为空')
  return { full, target: prepared.target }
}
