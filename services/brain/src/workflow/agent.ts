import { randomUUID } from 'node:crypto'
import { Value } from 'typebox/value'
import type { TSchema } from 'typebox'
import type { BrainConfig } from '../config.ts'
import { createModelRuntime } from '../llm.ts'
import type { LlmTarget } from '../runtime/contracts.ts'
import { executeAgent } from '../turn/agent-executor.ts'
import { createToolChain } from '../turn/tool-chain.ts'
import type { AgentRunResult } from './types.ts'

/**
 * 工作流子代理（对应参考实现的 agent() 后端）：一个只有只读工具的子回合，
 * 给一段任务提示，拿回文本或结构化结果。
 *
 * 与用户主回合的区别：
 * - 不注入人格与记忆（子代理是内部工人，不是对话对象）
 * - 不给 bash（没有确认通道，工作流里跑命令等于绕过用户确认）
 * - 不注册 workflow 工具本身（禁止递归工作流）
 * - 回合数有上限（防止工具循环无限跑）
 */

const MAX_TURNS = 6
/** 结构化输出要求（与参考实现一致：最后一条消息是纯 JSON 对象） */
const SCHEMA_INSTRUCTION = `

【输出格式】你的最终回答必须是一个 JSON 对象，且严格符合下面给出的 JSON Schema。
- 只输出 JSON 本身，不要解释、不要前后缀；可以用 markdown 代码块包裹
- 不要在 JSON 之外再写任何内容
JSON Schema：
`

const WORKER_SYSTEM_PROMPT = `你是多代理工作流中的一名子代理。你只负责完成分配给你的这一项子任务。
要求：
- 不要寒暄、不要复述任务、不要解释你在做什么，直接给结果
- 需要事实时用工具查证；查不到就明确说"未能查到"，不要编造
- 结论要具体：给出数字、名称、来源等可核对的信息
- 默认用中文回答`

export interface WorkflowAgentOptions {
  cfg: BrainConfig
  target: LlmTarget
  signal: AbortSignal
  prompt: string
  /** JSON Schema（TypeBox / 标准 JSON Schema 均可）：给了就返回结构化对象 */
  schema?: Record<string, unknown>
  maxTokens?: number
  /** 允许使用的工具名；缺省 = 全部只读工具 */
  allowedTools?: string[]
}

/** 执行一次子代理；失败抛错由上层转成 dead 并决定是否重试 */
export async function runWorkflowAgent(options: WorkflowAgentOptions): Promise<AgentRunResult> {
  const chain = createToolChain({
    cfg: { tools: options.cfg.tools }, turnId: randomUUID(), channel: 'feishu',
    capabilities: { vision: options.target.vision, proxy: options.target.proxy },
    enabled: true, includeMcp: false, signal: options.signal, onEvent: () => {}
  })
  const schemaInstruction =
    options.schema !== undefined ? `${SCHEMA_INSTRUCTION}${JSON.stringify(options.schema, null, 2)}` : ''
  let lastText = ''
  let outputTokens = 0
  try {
    const result = await executeAgent({
      runtime: createModelRuntime(options.target, { maxTokens: options.maxTokens }),
      systemPrompt: WORKER_SYSTEM_PROMPT + schemaInstruction,
      messages: [{ role: 'user', content: options.prompt, timestamp: Date.now() }],
      // 工作流没有确认通道，沿用非桌面只读工具且不注入 skill/MCP/workflow。
      tools: chain.tools.filter((tool) => !options.allowedTools || options.allowedTools.includes(tool.name)),
      beforeToolCall: chain.beforeToolCall, maxTurns: MAX_TURNS, signal: options.signal, onEvent: () => {}
    })
    if (result.aborted) throw new Error('工作流已取消')
    lastText = result.lastText
    outputTokens = result.usage.output
  } finally {
    chain.dispose()
  }

  if (options.schema === undefined) {
    if (!lastText.trim()) return { kind: 'dead', reason: 'empty-output' }
    return { kind: 'ok', output: lastText.trim(), outputTokens }
  }

  const parsed = extractJsonObject(lastText)
  if (parsed === undefined) {
    return { kind: 'dead', reason: 'no-structured-output', detail: lastText.slice(-200) }
  }
  // 结构校验：不合格就当 dead（与参考实现一致，交上层重试一次）
  try {
    if (!Value.Check(options.schema as TSchema, parsed)) {
      return { kind: 'dead', reason: 'invalid-structured-output', detail: JSON.stringify(parsed).slice(0, 200) }
    }
  } catch (error) {
    return {
      kind: 'dead',
      reason: 'invalid-schema',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  return { kind: 'ok', output: parsed, outputTokens }
}

/**
 * 从模型输出里抽 JSON 对象：先看 ```json 代码块，再扫描第一个花括号配对片段。
 * 只接受对象（数组 / 数字 / null 都算失败），与参考实现一致。
 */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim())
    if (parsed !== undefined) return parsed
  }
  const start = text.indexOf('{')
  if (start < 0) return undefined
  const end = findClosingBrace(text, start)
  if (end < 0) return undefined
  return tryParse(text.slice(start, end + 1))
}

function tryParse(raw: string): unknown {
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function findClosingBrace(source: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (quote) {
      if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}
