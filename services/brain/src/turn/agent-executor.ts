import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentOptions, AgentTool } from '@earendil-works/pi-agent-core'
import type { ModelRuntime } from '../runtime/contracts.ts'
import type { AgentExecutionResult, TurnEvent } from './contracts.ts'

export interface AgentExecutionOptions {
  runtime: ModelRuntime
  systemPrompt: string
  /** 包含本次用户消息；执行器自行把最后一条交给 prompt，不能再重复 append。 */
  messages: AgentMessage[]
  tools: AgentTool[]
  signal?: AbortSignal
  beforeToolCall?: AgentOptions['beforeToolCall']
  transformContext?: AgentOptions['transformContext']
  maxTurns?: number
  onEvent: (event: TurnEvent) => void
}

/** 唯一的 pi-agent-core 生命周期适配器：不选模型、不装工具、不写库，也不生成 SSE。 */
export async function executeAgent(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const result: AgentExecutionResult = {
    full: '', lastText: '', usage: { input: 0, output: 0, total: 0 }, toolNames: [], aborted: false
  }
  if (options.signal?.aborted) return { ...result, aborted: true }
  const prompt = options.messages.at(-1)
  if (!prompt) throw new Error('LLM 上下文为空')
  let turns = 0
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.runtime.model,
      messages: options.messages.slice(0, -1),
      tools: options.tools
    },
    streamFn: options.runtime.streamFn,
    beforeToolCall: options.beforeToolCall,
    transformContext: options.transformContext,
    shouldStopAfterTurn: options.maxTurns === undefined ? undefined : () => ++turns >= options.maxTurns!
  })
  const emit = (event: TurnEvent): void => {
    if (!options.signal?.aborted) options.onEvent(event)
  }
  const unsubscribe = agent.subscribe((event): void => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          const delta = event.assistantMessageEvent.delta
          result.full += delta
          emit({ type: 'delta', delta })
        }
        return
      case 'message_end':
        if (event.message.role === 'assistant') {
          const text = textOf(event.message.content)
          // 子代理只取最后一条非空正文；主回合仍保留所有流式正文。
          if (text.trim()) result.lastText = text
          result.usage.input += event.message.usage?.input ?? 0
          result.usage.output += event.message.usage?.output ?? 0
          result.usage.total += event.message.usage?.totalTokens ?? 0
        }
        return
      case 'tool_execution_start':
        emit({ type: 'tool_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args ?? {} })
        return
      case 'tool_execution_update':
        emit({ type: 'tool_update', toolCallId: event.toolCallId, toolName: event.toolName, partial: textOf(event.partialResult?.content) })
        return
      case 'tool_execution_end':
        result.toolNames.push(event.toolName)
        emit({ type: 'tool_end', toolCallId: event.toolCallId, toolName: event.toolName,
          isError: event.isError, result: textOf(event.result?.content), details: { ...(event.result?.details ?? {}) } })
        return
    }
  })
  const onAbort = (): void => agent.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // 准备时已取消不能启动请求；prompt 同步启动以后再补查一次，堵住监听注册窗口。
    if (!options.signal?.aborted) {
      const run = agent.prompt(prompt)
      if (options.signal?.aborted) agent.abort()
      await run
    }
  } finally {
    // 执行结束/异常 → idle：等 SDK 工具和订阅全部落定后才交还资源所有权。
    agent.abort()
    await agent.waitForIdle()
    unsubscribe()
    options.signal?.removeEventListener('abort', onAbort)
  }
  result.aborted = options.signal?.aborted === true
  if (result.aborted) result.full = ''
  else if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
  if (result.usage.total === 0) result.usage.total = result.usage.input + result.usage.output
  return result
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block !== 'object' || block === null) return ''
    const value = block as { type?: string; text?: unknown }
    return value.type === 'text' ? String(value.text ?? '') : ''
  }).join('')
}
