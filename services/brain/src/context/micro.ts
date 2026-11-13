import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import { estimateTextTokens, MESSAGE_OVERHEAD_TOKENS } from './tokens.ts'

/**
 * 回合内微压缩（对应 Claude Code 的 microCompact）：不调用 LLM，只把**较早的
 * 工具结果**替换成一行占位说明，保留最近几条原文。
 *
 * 为什么只动工具结果：工具结果通常是上下文里最长、时效性最强的部分（读文件、
 * 搜索结果、命令输出），模型很少回头逐字复读；而用户消息与助手回复是对话本身，
 * 删掉会改变语义。工具循环越长（一次回合里几十次调用），这一层收益越大。
 */

/** 占位符：说明这里原来有什么、被压缩了多少，模型据此知道需要时可以重新调用工具 */
function toolResultStub(toolName: string, originalChars: number): string {
  return `[较早的工具结果已压缩：${toolName}，原 ${originalChars} 字符。如确需原文请重新调用该工具]`
}

function textOfContent(content: string | readonly { type: string; text?: unknown }[]): string {
  if (typeof content === 'string') return content
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += String(block.text ?? '')
  }
  return text
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return (message as { role?: string }).role === 'toolResult'
}

/** 单条 AgentMessage 的 token 估算（文本部分 + 固定开销） */
export function estimateAgentMessageTokens(message: AgentMessage): number {
  const role = (message as { role?: string }).role
  if (role === 'user') {
    const content = (message as UserMessage).content
    const text = typeof content === 'string' ? content : textOfContent(content)
    return estimateTextTokens(text) + MESSAGE_OVERHEAD_TOKENS
  }
  if (role === 'assistant') {
    let text = ''
    for (const block of (message as AssistantMessage).content) {
      if (block.type === 'text') text += block.text
      // 工具调用参数也会进上下文，按 JSON 长度的 1/3 粗估
      else if (block.type === 'toolCall') text += JSON.stringify(block.arguments ?? {})
    }
    return estimateTextTokens(text) + MESSAGE_OVERHEAD_TOKENS
  }
  if (role === 'toolResult') {
    return estimateTextTokens(textOfContent((message as ToolResultMessage).content)) + MESSAGE_OVERHEAD_TOKENS
  }
  return MESSAGE_OVERHEAD_TOKENS
}

export function estimateAgentMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const message of messages) total += estimateAgentMessageTokens(message)
  return total
}

export interface MicroCompactOptions {
  /** 保留最近多少条工具结果原文（更早的才压缩） */
  keepRecentToolResults: number
  /** 保留末尾多少条消息永不压缩（通常是当前用户消息与最近一轮工具交互） */
  keepTailMessages?: number
}

/**
 * 返回压缩后的新数组（不修改入参）；没有可压缩内容时原样返回。
 * 规矩：工具结果之外的任何消息都不动；末尾 keepTailMessages 条不动；
 * 已经是占位符的（没有正文）跳过，避免反复处理。
 */
export function microCompactMessages(
  messages: AgentMessage[],
  options: MicroCompactOptions
): AgentMessage[] {
  const keepTail = options.keepTailMessages ?? 2
  const toolResultIndexes: number[] = []
  messages.forEach((message, index) => {
    if (isToolResult(message)) toolResultIndexes.push(index)
  })

  // 保留最近 N 条工具结果原文；其余都是候选
  const compactable = new Set(toolResultIndexes.slice(0, Math.max(0, toolResultIndexes.length - options.keepRecentToolResults)))
  if (compactable.size === 0) return messages

  const tailStart = messages.length - keepTail
  let changed = false
  const next = messages.map((message, index) => {
    if (!compactable.has(index) || index >= tailStart) return message
    if (!isToolResult(message)) return message
    const originalText = textOfContent(message.content)
    // 没有正文（只有图片 / 已压缩过）→ 不动
    if (!originalText) return message
    changed = true
    const stub: ToolResultMessage = {
      ...message,
      content: [{ type: 'text', text: toolResultStub(message.toolName, originalText.length) }]
    }
    return stub
  })
  return changed ? next : messages
}
