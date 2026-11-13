import { Worker } from 'node:worker_threads'
import vm from 'node:vm'
import { ScriptError, WorkflowAbortedError } from './errors.ts'
import type { WorkflowHooks, WorkflowMeta } from './types.ts'

/**
 * 工作流脚本的解析与执行。
 *
 * 执行在**独立 worker 线程**里（`sandbox.ts`），不是主线程的 new Function：
 * 沙箱里没有任何宿主对象（JSON/Math/Date 等都是 vm 自己的 realm），宿主与脚本
 * 之间只传 JSON 字符串，脚本碰不到 `process` / `require` / 网络 / 文件。
 * 超时或取消时直接 `worker.terminate()`——同步死循环与 await 之后的死循环都能杀掉。
 *
 * 仍然要说清楚边界：这是"无宿主能力 + 无对象泄漏"的隔离，不是经过审计的
 * 安全容器。它与主进程共享同一个 Node 二进制；若 vm 本身出现逃逸漏洞，
 * 沙箱仍可能被突破。真正的强隔离需要独立进程/容器级别的方案。
 */

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
  /** 脚本通过 `args` 拿到实参（必须是可 JSON 序列化的值） */
  args?: unknown
  /** 同步执行段（首个 await 之前）的超时 */
  syncTimeoutMs?: number
  /** 取消 / 整体超时：直接终止 worker */
  signal?: AbortSignal
}

type WorkerOutMessage =
  | { t: 'agent'; id: number; prompt: string; optsJson: string }
  | { t: 'phase'; title: string }
  | { t: 'log'; message: string }
  | { t: 'done'; valueJson: string }
  | { t: 'error'; message: string }

/**
 * 在独立 worker 里执行脚本体，返回脚本 `return` 的值。
 * 脚本与宿主之间只传 JSON 字符串：脚本拿不到任何宿主对象，也就没有
 * `obj.constructor.constructor('return process')` 这条逃逸链。
 */
export async function runScript(body: string, options: RunScriptOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sandbox.ts', import.meta.url), {
      workerData: {
        body,
        argsJson: safeStringify(options.args ?? null),
        syncTimeoutMs: options.syncTimeoutMs ?? 5_000
      },
      // 沙箱线程不继承环境变量（里面有 LLM 密钥）与 CLI 参数
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true
    })

    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      action()
      void worker.terminate()
    }
    const onAbort = (): void => finish(() => reject(new WorkflowAbortedError()))
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (raw: WorkerOutMessage) => {
      switch (raw.t) {
        case 'agent': {
          // 宿主侧执行子代理；结果以 JSON 字符串回传
          const opts = parseOpts(raw.optsJson)
          void options.hooks
            .agent(raw.prompt, opts)
            .then(
              (value) =>
                worker.postMessage({
                  t: 'agentResult',
                  id: raw.id,
                  ok: true,
                  valueJson: safeStringify(value ?? null)
                }),
              (error: unknown) =>
                worker.postMessage({
                  t: 'agentResult',
                  id: raw.id,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                  abort: options.signal?.aborted === true
                })
            )
          return
        }
        case 'phase':
          options.hooks.phase(raw.title)
          return
        case 'log':
          options.hooks.log(raw.message)
          return
        case 'done':
          finish(() => {
            try {
              resolve(JSON.parse(raw.valueJson) as unknown)
            } catch {
              resolve(undefined)
            }
          })
          return
        case 'error':
          finish(() => reject(scriptRuntimeError(raw.message)))
          return
        default:
          return
      }
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      // 正常完成时 worker 也会退出；settled 已置位则忽略
      if (settled) return
      finish(() => reject(new WorkflowAbortedError(`沙箱线程意外退出（code ${code}）`)))
    })
  })
}

/** 脚本传来的 opts：只接受普通对象，其余（null / 数组 / 非对象）一律当未传 */
function parseOpts(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function scriptRuntimeError(message: string): Error {
  const error = new Error(message)
  error.name = 'ScriptRuntimeError'
  return error
}

/** 序列化：失败时降级成一个可读的占位（不把异常抛回沙箱） */
function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 'null' : text
  } catch {
    return JSON.stringify({ __unserializable: true })
  }
}
