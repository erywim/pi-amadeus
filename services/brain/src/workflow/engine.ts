import type { WorkflowLevel } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import type { LlmTarget } from '../llm.ts'
import { runWorkflowAgent } from './agent.ts'
import { parseScript, runScript, ScriptError } from './script.ts'
import {
  workflowLimitsOf,
  type AgentRunResult,
  type WorkflowEvent,
  type WorkflowHooks,
  type WorkflowRunResult,
  type WorkflowRunStats
} from './types.ts'

/**
 * 工作流引擎（对应参考实现的 engine/runWorkflow + hooks）：
 * 解析脚本 → 注入 agent/parallel/pipeline/phase/log → 跑脚本 → 汇总统计。
 *
 * 与参考实现保持一致的语义：
 * - parallel 是屏障（等全部完成，顺序与入参一致）；pipeline 逐项串行跑各阶段、项与项之间不设屏障
 * - agent() 失败（抛错或返回 dead）重试一次；abort 不重试
 * - 并发是 per-run 信号量，超出上限的 agent() 排队而不是报错
 * - 输出 token 预算只统计成功的 agent
 * 差异：没有跨运行 journal 重放（每次工具调用都是全新运行）。
 */

/** 单次运行的内部错误（脚本可以捕获；不应被 parallel/pipeline 吞掉的那类） */
class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

class WorkflowAbortedError extends Error {
  constructor() {
    super('工作流已取消')
    this.name = 'WorkflowAbortedError'
  }
}

/** 可中断的 FIFO 信号量 */
class Semaphore {
  private permits: number
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(permits: number) {
    this.permits = Math.max(1, permits)
  }

  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new WorkflowAbortedError()
    if (this.permits > 0) {
      this.permits -= 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        reject: (error: Error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        // 排队中被取消：把自己从队列里摘掉，不占名额
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new WorkflowAbortedError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    // 直接移交名额，避免 release 后立刻被别的调用抢走导致插队
    if (next) next.resolve()
    else this.permits += 1
  }
}

export interface RunWorkflowOptions {
  script: string
  args?: unknown
  /** 脚本请求的并发；缺省用档位默认值，超过档位上限会被 clamp */
  maxConcurrency?: number
  level: WorkflowLevel
  cfg: BrainConfig
  target: LlmTarget
  signal: AbortSignal
  onEvent: (event: WorkflowEvent) => void
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const limits = workflowLimitsOf(options.level)
  if (!limits) throw new ScriptError('动态工作流档位为关闭状态')

  const parsed = parseScript(options.script, limits.maxScriptChars)
  const concurrency = clampConcurrency(options.maxConcurrency, limits.defaultConcurrency, limits.maxConcurrency)

  // 整体超时与外部取消合并到同一个 signal：脚本、子代理、排队都认它
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  options.signal.addEventListener('abort', onOuterAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, limits.timeoutMs)
  const signal = controller.signal

  const semaphore = new Semaphore(concurrency)
  const budget = { total: limits.maxOutputTokens, spent: 0 }
  const stats = {
    agentsRun: 0,
    agentsFailed: 0,
    outputTokens: 0
  }
  let currentPhase: string | null = null
  const startedAt = Date.now()

  const emit = options.onEvent

  const closePhase = (): void => {
    if (currentPhase) {
      emit({ type: 'phase_done', phase: currentPhase })
      currentPhase = null
    }
  }

  /** 真正执行一次 agent()：并发 → 预算 → 执行 → 失败重试一次 → 记账 */
  const agentHook = async (prompt: unknown, rawOpts?: unknown): Promise<unknown> => {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new WorkflowError('agent(prompt) 的 prompt 必须是非空字符串')
    }
    const opts = (rawOpts ?? {}) as Record<string, unknown>
    if (stats.agentsRun >= limits.maxAgents) {
      throw new WorkflowError(`本次运行最多执行 ${limits.maxAgents} 个子代理（当前档位上限），请缩小任务规模`)
    }
    const agentId = stats.agentsRun + 1
    const label = typeof opts.label === 'string' && opts.label ? opts.label : `agent-${agentId}`
    const phase = typeof opts.phase === 'string' ? opts.phase : currentPhase ?? undefined

    const schema =
      typeof opts.schema === 'object' && opts.schema !== null && !Array.isArray(opts.schema)
        ? (opts.schema as Record<string, unknown>)
        : undefined
    if (opts.schema !== undefined && schema === undefined) {
      throw new WorkflowError('agent(prompt, { schema }) 的 schema 必须是 JSON Schema 对象')
    }

    await semaphore.acquire(signal)
    try {
      if (signal.aborted) throw new WorkflowAbortedError()
      if (budget.spent >= budget.total) {
        throw new WorkflowError(`本次运行输出 token 预算已用尽（${budget.total}），请缩小任务规模`)
      }
      if (stats.agentsRun >= limits.maxAgents) {
        throw new WorkflowError(`本次运行最多执行 ${limits.maxAgents} 个子代理，请缩小任务规模`)
      }
      stats.agentsRun += 1
      emit({ type: 'agent_started', agentId, label, phase })

      const result = await withRetry(
        () =>
          runWorkflowAgent({
            cfg: options.cfg,
            target: options.target,
            signal,
            prompt,
            schema,
            maxTokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : undefined,
            allowedTools: Array.isArray(opts.allowedTools)
              ? opts.allowedTools.filter((name): name is string => typeof name === 'string')
              : undefined
          }),
        signal
      )

      if (result.kind === 'ok') {
        budget.spent += result.outputTokens
        stats.outputTokens += result.outputTokens
        emit({ type: 'agent_done', agentId, label, ok: true })
        return result.output
      }
      stats.agentsFailed += 1
      emit({ type: 'agent_done', agentId, label, ok: false, detail: result.reason })
      return null
    } finally {
      semaphore.release()
    }
  }

  const hooks: WorkflowHooks = {
    agent: agentHook,
    parallel: async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> => {
      if (!Array.isArray(thunks)) throw new WorkflowError('parallel(thunks) 需要函数数组')
      if (thunks.length > 4096) throw new WorkflowError('parallel 一次最多 4096 项')
      const results = await Promise.all(
        thunks.map(async (thunk) => {
          try {
            return await thunk()
          } catch (error) {
            // 取消要冒泡，让整次运行标记为 killed；其余错误降级为 null（与参考实现一致）
            if (error instanceof WorkflowAbortedError || signal.aborted) throw error
            emit({ type: 'log', message: `parallel 中的一项失败：${errorText(error)}` })
            return null
          }
        })
      )
      return results
    },
    pipeline: async <T, R>(
      items: readonly T[],
      ...stages: Array<(prev: unknown, item: T, index: number) => Promise<unknown>>
    ): Promise<Array<R | null>> => {
      if (!Array.isArray(items)) throw new WorkflowError('pipeline(items, ...stages) 需要数组')
      if (items.length > 4096) throw new WorkflowError('pipeline 一次最多 4096 项')
      const results = await Promise.all(
        items.map(async (item, index) => {
          let previous: unknown = item
          try {
            for (const stage of stages) previous = await stage(previous, item, index)
            return previous as R
          } catch (error) {
            if (error instanceof WorkflowAbortedError || signal.aborted) throw error
            emit({ type: 'log', message: `pipeline 第 ${index + 1} 项失败：${errorText(error)}` })
            return null
          }
        })
      )
      return results
    },
    phase: (title: string): void => {
      if (typeof title !== 'string' || !title.trim()) return
      closePhase()
      currentPhase = title
      emit({ type: 'phase_started', phase: title })
    },
    log: (message: string): void => {
      emit({ type: 'log', message: String(message) })
    }
  }

  let returnValue: unknown
  let status: WorkflowRunStats['status'] = 'completed'
  let error: string | undefined
  try {
    returnValue = await runScript(parsed.body, { hooks, args: options.args })
  } catch (caught) {
    if (signal.aborted || caught instanceof WorkflowAbortedError) {
      status = 'aborted'
      error = timedOut ? '工作流超时' : '工作流已取消'
    } else {
      status = 'failed'
      error = errorText(caught)
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onOuterAbort)
    closePhase()
  }

  return {
    meta: parsed.meta,
    returnValue,
    stats: {
      status,
      agentsRun: stats.agentsRun,
      agentsFailed: stats.agentsFailed,
      outputTokens: stats.outputTokens,
      durationMs: Date.now() - startedAt,
      error
    }
  }
}

/** 失败重试一次（取消不重试），与参考实现一致 */
async function withRetry(
  run: () => Promise<AgentRunResult>,
  signal: AbortSignal
): Promise<AgentRunResult> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal.aborted) throw new WorkflowAbortedError()
    try {
      const result = await run()
      if (result.kind === 'ok') return result
      lastError = new Error(`${result.reason}${result.detail ? `: ${result.detail}` : ''}`)
    } catch (error) {
      if (error instanceof WorkflowAbortedError || signal.aborted) throw new WorkflowAbortedError()
      lastError = error
    }
  }
  return {
    kind: 'dead',
    reason: 'run-failed',
    detail: errorText(lastError)
  }
}

function clampConcurrency(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(1, Math.floor(value)), max)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
