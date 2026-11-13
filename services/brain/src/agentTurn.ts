import { randomUUID } from 'node:crypto'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import type { Channel, SseEvent, TurnMode } from '@pi-amadeus/shared'
import { AsyncQueue } from './bilingual.ts'
import type { BrainConfig } from './config.ts'
import { prepareTurn } from './conversation.ts'
import type { Db } from './db.ts'
import { createAgentStreamFn, getLlm, type LlmTarget } from './llm.ts'
import { createKnowledgeTool } from './knowledge/index.ts'
import type { SavedAttachment } from './media.ts'
import { mcpManager } from './mcp/manager.ts'
import { disabledSkillNames } from './plugins/registry.ts'
import { markProviderFailure, markProviderSuccess } from './providers/failover.ts'
import { createUseSkillTool, loadSkillBundle, skillsPrompt } from './skills/index.ts'
import { deniedMessage, rejectAllForTurn, requestBashConfirm } from './tools/confirm.ts'
import { BLOCK_PREFIX, blockReason, checkBashSafety } from './tools/safety.ts'
import { buildToolRegistry } from './tools/index.ts'
import { diffSnapshots, gitSnapshot } from './workspace.ts'

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
  /** 是否把本次用户消息写入会话（重新生成传 false，历史里已有那条消息） */
  appendUserMessage?: boolean
  /** 重新生成时要排除的历史消息 id（旧助手回答） */
  omitMessageId?: string
  /** 本次用户消息的附件（图片 / 语音 / 文件） */
  attachments?: SavedAttachment[]
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
  /** 本次落库的用户消息 id（重新生成/编辑重发不写用户消息时为空） */
  userMessageId?: string
  /** 本回合工作区改动（桌面端真实 git 快照差集；非 Git 或未知时为空） */
  changedFiles?: Array<{ path: string; status: string }>
  /** 模型真实返回的思考内容（开启思考且供应商返回时才有；工具循环内各次调用的思考累计） */
  thinking?: string
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
    content: opts.content,
    appendUserMessage: opts.appendUserMessage,
    omitMessageId: opts.omitMessageId,
    attachments: opts.attachments,
    branchParentId: opts.branchParentId
  })
  if (opts.signal?.aborted) {
    return {
      full: '',
      target: prepared.target,
      usage: { input: 0, output: 0, total: 0 },
      toolCalls: 0,
      toolNames: [],
      userMessageId: prepared.userMessageId
    }
  }

  const toolsEnabled = prepared.userConfig?.tools?.enabled !== false
  // 思考展示开关：是否把模型返回的 reasoning 上屏与落库
  // （LlmTarget 只在真正开启时才带 thinkingLevel，off 不会出现在这里）
  const thinkingEnabled = Boolean(prepared.target.thinkingLevel)
  const queue = new AsyncQueue<SseEvent>()
  let full = ''
  let thinking = ''
  /** 最近一条助手消息的停止原因（length = 被输出上限截断） */
  let lastStopReason = ''
  // 指标：工具循环里每次 LLM 调用都会带 usage，逐次累加才是本回合真实消耗
  const usage: AgentTurnUsage = { input: 0, output: 0, total: 0 }
  const toolNames: string[] = []

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
        confirmRequest,
        ...(opts.signal ? { signal: opts.signal } : {})
      })
    : []

  // skill：文件形式、每回合热加载；启用列表注入 systemPrompt + use_skill 工具。
  // 插件中心关掉的 skill 与文件状态表里的停用取并集，两处入口效果一致
  const disabledSkills = toolsEnabled ? await disabledSkillNames(opts.db) : new Set<string>()
  const skillBundle = toolsEnabled ? await loadSkillBundle(opts.cfg, disabledSkills) : { skills: [] }
  if (skillBundle.skills.length > 0) {
    tools.push(createUseSkillTool(skillBundle.skills))
  }
  // 知识库工具：用户建过知识库才注册（没有知识库时模型不该看到这个工具）
  if (toolsEnabled) {
    const knowledgeTool = await createKnowledgeTool(opts.db, opts.userId)
    if (knowledgeTool) tools.push(knowledgeTool)
  }
  // MCP 插件工具：只取当前已连接的服务，连接失败不阻塞本回合
  if (toolsEnabled) tools.push(...mcpManager.listAgentTools())
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
      // 思考级别写进 Agent 状态：pi 每次请求读取它并作为 reasoning 下发。
      // 未配置时保持默认，参数层面与旧行为完全一致。
      ...(prepared.target.thinkingLevel
        ? { thinkingLevel: prepared.target.thinkingLevel }
        : {}),
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
        } else if (event.assistantMessageEvent.type === 'thinking_delta') {
          /**
           * 思考增量单独上屏：不混进正文，也不参与「LLM 返回为空」的判定。
           * 只有用户开启了思考才转发与落库——部分端点（如推理模型）即使没请求
           * 也会回 reasoning_content，开关关闭却照常展示就成了一张假开关。
           */
          const delta = event.assistantMessageEvent.delta
          if (delta && thinkingEnabled) {
            thinking += delta
            queue.push({ type: 'thinking', delta })
          }
        }
        return
      case 'message_end':
        // 每条助手消息结束都带 usage；工具循环里的每次调用都要计入本回合
        if (event.message.role === 'assistant') {
          if (event.message.usage) {
            usage.input += event.message.usage.input ?? 0
            usage.output += event.message.usage.output ?? 0
            usage.total += event.message.usage.totalTokens ?? 0
          }
          // 记录停止原因：length = 被输出上限截断，用于给出可操作的错误提示
          if (event.message.stopReason) lastStopReason = event.message.stopReason
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

  // 回合开始前的 git 状态快照：回合结束后取差集，得到「这回合真实改了哪些文件」。
  // 只在桌面端做（其它渠道没有本机工作区可看），且 shell 工具关闭时也不做
  const trackWorkspace = opts.channel === 'desktop' && toolsEnabled
  const beforeSnapshot = trackWorkspace ? await gitSnapshot(opts.cfg.workspace.root) : null

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

  if (opts.signal?.aborted) {
    return {
      full: '',
      target: prepared.target,
      usage,
      toolCalls: toolNames.length,
      toolNames,
      userMessageId: prepared.userMessageId
    }
  }
  // 真实回合失败 → 该服务进入冷却，下一回合自动按 priority 换健康服务；
  // 成功一次立即解除冷却。中止（用户点停止）不算服务故障。
  if (agent.state.errorMessage) {
    markProviderFailure(prepared.target.providerId)
    const raw = agent.state.errorMessage
    /**
     * 上游拒绝思考参数时原始报错只有 "400 upstream_rejected"，对用户没有任何指引。
     * 不同端点支持的思考档位不同（例如只认 low/high/max），这里把这种情况
     * 翻译成「换一档或关掉」——只改措辞不掩盖失败，错误仍然照实抛出。
     */
    if (thinkingEnabled && /\b400\b|upstream_rejected|reasoning/i.test(raw)) {
      throw new Error(
        `当前模型服务不接受「${prepared.target.thinkingLevel}」思考档位（原始错误：${raw}）。` +
          '请在设置里换一个思考档位或关闭思考模式后重试。'
      )
    }
    throw new Error(raw)
  }
  if (!full) {
    markProviderFailure(prepared.target.providerId)
    if (thinkingEnabled) {
      // 开了思考但没正文：几乎都是输出上限被思考吃光（推理模型共享 maxTokens）
      throw new Error(
        '模型把输出上限全用在思考上了，没有留下正文。请调高「输出上限」，或把「思考模式」调低/关闭。'
      )
    }
    // 停止原因是 length：输出上限/上下文窗口太小，连一句话都放不下
    throw new Error(
      lastStopReason === 'length'
        ? '回复被输出上限截断了（连正文都没留下）。请调高「输出上限」，或核对「上下文窗口」是否填得太小。'
        : 'LLM 返回为空'
    )
  }
  markProviderSuccess(prepared.target.providerId)
  // totalTokens 缺失时用输入+输出兜底（部分兼容端点不返回 total）
  if (usage.total === 0) usage.total = usage.input + usage.output
  const changedFiles = trackWorkspace
    ? diffSnapshots(beforeSnapshot, await gitSnapshot(opts.cfg.workspace.root))
    : []
  return {
    full,
    target: prepared.target,
    usage,
    toolCalls: toolNames.length,
    toolNames,
    userMessageId: prepared.userMessageId,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(thinking.trim() ? { thinking: thinking.trim() } : {})
  }
}
