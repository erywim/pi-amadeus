import type { AgentOptions, AgentTool, Skill } from '@earendil-works/pi-agent-core'
import type { Channel } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import { mcpManager } from '../mcp/manager.ts'
import { createUseSkillTool, skillsPrompt } from '../skills/index.ts'
import { buildToolRegistry } from '../tools/index.ts'
import { deniedMessage, rejectAllForTurn, requestToolConfirm, ToolDeniedError } from '../tools/confirm.ts'
import { BLOCK_PREFIX, blockReason, checkBashSafety } from '../tools/safety.ts'
import { DesktopBridge, registerDesktopBridge, unregisterDesktopBridge } from '../tools/desktop-bridge.ts'
import type { TurnEvent } from './contracts.ts'

export interface ToolChainOptions {
  cfg: Pick<BrainConfig, 'tools'>
  turnId: string
  channel: Channel
  /** 只传工具需要的能力与出站代理，不持有模型服务/密钥。 */
  capabilities: { vision: boolean; proxy?: string }
  enabled: boolean
  computerEnabled?: boolean
  signal: AbortSignal
  skills?: Skill[]
  includeMcp?: boolean
  /** 工作流等扩展由组合根注入，工具链不反向导入模型执行器。 */
  extraTools?: AgentTool[]
  promptAdditions?: string
  onEvent: (event: TurnEvent) => void
}

export interface ToolChain {
  tools: AgentTool[]
  systemPromptAdditions: string
  beforeToolCall: AgentOptions['beforeToolCall']
  decorateEvent: (event: TurnEvent) => TurnEvent
  dispose: () => void
}

/** 装配与权限属于工具层；模型选择和状态迁移不在这里发生。 */
export function createToolChain(options: ToolChainOptions): ToolChain {
  const { cfg, turnId, signal } = options
  let disposed = false
  const emit = (event: TurnEvent): void => {
    if (!disposed && !signal.aborted) options.onEvent(event)
  }
  const confirm = async (request: {
    toolCallId: string; toolName: string; label: string; kind: 'bash' | 'computer'; args: Record<string, unknown>
  }, toolSignal?: AbortSignal): Promise<boolean> => {
    const pending = requestToolConfirm({ ...request, turnId, timeoutMs: cfg.tools.confirmTimeoutMs,
      signal: toolSignal ? AbortSignal.any([signal, toolSignal]) : signal })
    emit({ type: 'tool_confirm', ...request, expiresAt: pending.expiresAt })
    try {
      return await pending.promise
    } finally {
      // 批准/拒绝/超时 → 确认落定；取消后事件被抑制，由组合根进入 cancelled。
      emit({ type: 'approval_settled', toolCallId: request.toolCallId })
    }
  }
  const bridge = options.enabled && options.computerEnabled && options.channel === 'desktop' && options.capabilities.vision
    ? new DesktopBridge({ turnId, signal, timeoutMs: cfg.tools.computerTimeoutMs, push: emit })
    : undefined
  const tools = options.enabled ? buildToolRegistry({
    cfg, channel: options.channel, target: options.capabilities, signal, desktopBridge: bridge,
    confirmRequest: async (toolCallId, command) => {
      // 审批必须显示完整可执行内容；拒绝超大命令，不能截断后批准隐藏前缀。
      if (Buffer.byteLength(command, 'utf8') > 16 * 1024) {
        throw new ToolDeniedError('blocked', blockReason('命令超过 16 KiB，请拆分为可完整审阅的命令'))
      }
      return confirm({ toolCallId, toolName: 'bash', label: '执行命令', kind: 'bash', args: { command } })
    }
  }) : []
  const skills = options.enabled ? options.skills ?? [] : []
  if (skills.length) tools.push(createUseSkillTool(skills))
  if (options.enabled && options.includeMcp !== false) {
    tools.push(...mcpManager.listAgentTools({
      allowComputerUse: options.channel === 'desktop' && options.capabilities.vision && options.computerEnabled === true,
      requestConfirm: (request, toolSignal) => confirm({ toolCallId: request.toolCallId, toolName: request.toolName,
        label: `${request.serverName} · ${request.toolName}`, kind: 'computer', args: request.args }, toolSignal)
    }))
  }
  if (options.enabled) tools.push(...options.extraTools ?? [])
  const systemPromptAdditions = options.enabled ? skillsPrompt(skills) + (options.promptAdditions ?? '') : ''
  // 完成所有装配后才注册：中途失败不能让旧 bridge 或审批残留到下一回合。
  if (bridge) registerDesktopBridge(bridge)
  return {
    tools,
    systemPromptAdditions,
    beforeToolCall: async (context) => {
      if (context.toolCall.name !== 'bash') return undefined
      const command = String((context.args as Record<string, unknown>)?.command ?? '')
      const check = checkBashSafety(command)
      return check.allowed ? undefined : { block: true, reason: blockReason(check.reason) }
    },
    decorateEvent: (event) => {
      if (event.type !== 'tool_end' || event.toolName !== 'bash' || !event.isError) return event
      const reason = event.result.startsWith(BLOCK_PREFIX) ? 'blocked'
        : (['user_denied', 'timeout', 'aborted'] as const).find((value) => event.result.includes(deniedMessage(value)))
      return reason ? { ...event, details: { ...event.details, deniedReason: reason } } : event
    },
    dispose: () => {
      // 活动工具链 → 已关闭：先阻止迟到事件，再拒绝所有未决审批和桌面请求。
      disposed = true
      rejectAllForTurn(turnId)
      if (bridge) unregisterDesktopBridge(turnId)
    }
  }
}
