import vm from 'node:vm'
import type { WorkflowHooks, WorkflowMeta } from './types.ts'

/**
 * 工作流脚本的解析与执行（对应参考实现的 engine/script.ts）。
 *
 * 脚本是 AsyncFunction 的函数体：`agent` / `parallel` / `pipeline` / `phase` /
 * `log` / `args` 由引擎注入，用 `return` 交出结果；不是 ESM 模块，也不做 TS 转译。
 *
 * 安全边界：这是**本地桌面应用**，脚本由用户自己的模型生成。仍按最小权限跑：
 * - node:vm 独立上下文，不暴露 require / process / fetch / fs
 * - codeGeneration.strings=false：堵住 Function / eval 逃逸
 * - 同步执行部分有 timeout（防死循环）；异步整体超时由引擎的 Promise.race 兜底
 */

export class ScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

export interface ParsedScript {
  meta: WorkflowMeta
  /** 去掉 meta 声明后的脚本体 */
  body: string
}

const META_PATTERN = /export\s+const\s+meta\s*=\s*/

/**
 * 提取并校验 `export const meta = {...}`。
 * 必须先是对象字面量（花括号配对），再在无全局的 vm 里求值——
 * 引用了任何变量都会抛 ReferenceError，从而保证 meta 是纯字面量。
 */
export function parseScript(source: string, maxChars: number): ParsedScript {
  if (source.length > maxChars) {
    throw new ScriptError(`脚本过长（${source.length} 字符，上限 ${maxChars}）`)
  }
  const match = META_PATTERN.exec(source)
  if (!match) {
    throw new ScriptError('脚本必须以 `export const meta = { name, description, ... }` 开头')
  }
  const literalStart = match.index + match[0].length
  const end = findClosingBrace(source, literalStart)
  if (end < 0) throw new ScriptError('meta 的对象字面量没有闭合')

  const literal = source.slice(literalStart, end + 1)
  const meta = evaluateMetaLiteral(literal)
  validateMeta(meta)

  // 去掉 meta 声明本身（连同紧随的一个分号与换行），剩下的是函数体
  let after = source.slice(end + 1)
  if (after.startsWith(';')) after = after.slice(1)
  if (after.startsWith('\r\n')) after = after.slice(2)
  else if (after.startsWith('\n')) after = after.slice(1)
  const body = source.slice(0, match.index) + after

  assertScriptBody(body)
  return { meta, body }
}

/** 从 { 开始找配对的 }，跳过字符串与转义 */
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
    if (char === '"' || char === "'" || char === '`') {
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

/** 在无全局变量的沙箱里求值：引用了任何自由标识符都会失败 */
function evaluateMetaLiteral(literal: string): unknown {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }
  })
  try {
    return new vm.Script(`(${literal})`, { filename: 'workflow-meta.js' }).runInContext(context, {
      timeout: 200
    })
  } catch (error) {
    throw new ScriptError(
      `meta 必须是纯字面量（不能引用变量 / 调用函数 / 做插值）：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function validateMeta(value: unknown): asserts value is WorkflowMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScriptError('meta 必须是对象')
  }
  const meta = value as Record<string, unknown>
  if (typeof meta.name !== 'string' || !meta.name.trim()) {
    throw new ScriptError('meta.name 必须是非空字符串')
  }
  if (typeof meta.description !== 'string' || !meta.description.trim()) {
    throw new ScriptError('meta.description 必须是非空字符串')
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new ScriptError('meta.phases 必须是数组')
    for (const phase of meta.phases) {
      if (typeof phase !== 'object' || phase === null || typeof (phase as { title?: unknown }).title !== 'string') {
        throw new ScriptError('meta.phases 的每一项都必须是 { title: string, detail?: string }')
      }
    }
  }
}

/** 静态禁用项：import / 多余 export（与参考实现一致） */
function assertScriptBody(body: string): void {
  if (/^\s*import\b/m.test(body)) {
    throw new ScriptError('工作流脚本不是 ESM 模块：不要 import，agent/parallel/pipeline/phase/log/args 已直接注入')
  }
  if (/\bimport\s*\(/m.test(body)) {
    throw new ScriptError('工作流脚本里不允许动态 import()')
  }
  if (/^\s*export\b/m.test(body)) {
    throw new ScriptError('只允许一个 `export const meta = {...}`；其余 export 请去掉')
  }
}

export interface RunScriptOptions {
  hooks: WorkflowHooks
  /** 脚本通过 `args` 拿到实参 */
  args?: unknown
  /** 同步执行段（首个 await 之前）的超时 */
  syncTimeoutMs?: number
}

/**
 * 执行脚本，返回脚本 `return` 的值。
 * 异步阶段不设 vm 级超时（vm 的 timeout 只覆盖同步执行），由调用方用
 * Promise.race + AbortSignal 控制整体时长。
 */
export async function runScript(body: string, options: RunScriptOptions): Promise<unknown> {
  const sandbox: Record<string, unknown> = {
    agent: options.hooks.agent,
    parallel: options.hooks.parallel,
    pipeline: options.hooks.pipeline,
    phase: options.hooks.phase,
    log: options.hooks.log,
    args: options.args,
    // 常用内置对象显式提供（vm 上下文里默认没有这些全局）
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    console: { log: options.hooks.log, warn: options.hooks.log, error: options.hooks.log }
  }
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false }
  })
  // 顶层 return 只能出现在函数体里：包一层 async IIFE
  const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: 'workflow.js' })
  const result = script.runInContext(context, { timeout: options.syncTimeoutMs ?? 5_000 })
  return await (result as Promise<unknown>)
}
