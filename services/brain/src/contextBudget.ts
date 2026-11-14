import type { Context, ImageContent, TextContent } from '@earendil-works/pi-ai'

export const CONTEXT_TOO_LONG_PREFIX = '上下文过长'
const SAFETY_TOKENS = 4096
const IMAGE_TOKENS = 4096

function contentTokens(content: string | (TextContent | ImageContent)[]): number {
  if (typeof content === 'string') return content.length
  return content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : IMAGE_TOKENS), 0)
}

/** pi-ai 0.84 的估算器未公开导出；保守按每字符 1 token、每张图片 4096 token 计数。 */
export function assertContextBudget(context: Context, contextWindow: number): void {
  let inputTokens = context.systemPrompt?.length ?? 0
  if (context.tools?.length) inputTokens += JSON.stringify(context.tools).length
  for (const message of context.messages) {
    inputTokens += 16 // 消息角色、工具调用 id 等协议开销
    if (message.role === 'user' || message.role === 'toolResult') {
      inputTokens += contentTokens(message.content)
    } else {
      for (const block of message.content) {
        if (block.type === 'text') inputTokens += block.text.length
        else if (block.type === 'thinking') inputTokens += block.thinking.length
        else inputTokens += block.name.length + JSON.stringify(block.arguments).length
      }
    }
  }
  // 输入超出安全预算就由待请求转为明确失败；不发送、不删历史，也不钳成 1 token 假装可用。
  if (inputTokens > contextWindow - SAFETY_TOKENS) {
    throw new Error(`${CONTEXT_TOO_LONG_PREFIX}：保守估算输入 ${inputTokens} tokens，窗口 ${contextWindow} tokens（预留 ${SAFETY_TOKENS}）。请减少输入/附件、新建会话，或核对「上下文窗口」。`)
  }
}
