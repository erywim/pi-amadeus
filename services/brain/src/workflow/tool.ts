import { type Static, Type } from 'typebox'
import type { AgentTool, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core'
import type { WorkflowLevel } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import type { LlmTarget } from '../llm.ts'
import { runWorkflow } from './engine.ts'
import { workflowLimitsOf, type WorkflowEvent, type WorkflowRunResult } from './types.ts'

/**
 * Workflow 工具（对应参考实现的 Workflow 工具）：模型写一段 JS 脚本，
 * 脚本用 agent()/parallel()/pipeline() 编排多个子代理，引擎确定性执行。
 *
 * 进度通过工具 onUpdate 上屏（复用现有 tool_update 事件，不新增 SSE 词汇）；
 * 最终结果返回给模型的是运行统计 + 脚本 return 值。
 */

export const workflowToolSchema = Type.Object({
  script: Type.String({
    description:
      '工作流脚本源码（普通 JS，不是 ESM/TS）。必须以 `export const meta = { name, description, phases? }` 开头，' +
      '用 return 交出结果；agent/parallel/pipeline/phase/log/args 已注入，直接使用'
  }),
  args: Type.Optional(
    Type.Unknown({ description: '传给脚本 args 变量的实参（真实 JSON 值，不要传 JSON 字符串）' })
  ),
  description: Type.Optional(Type.String({ description: '这次运行的一句话说明（3~5 个词）' })),
  maxConcurrency: Type.Optional(
    Type.Number({ description: '并发上限（不填用档位默认值；超过档位上限会被压到上限）' })
  )
})

type WorkflowToolArgs = Static<typeof workflowToolSchema>

export interface WorkflowToolOptions {
  cfg: BrainConfig
  target: LlmTarget
  level: WorkflowLevel
}

/** 进度文本最多保留多少行（再多的老行丢弃，只留最近的过程） */
const MAX_PROGRESS_LINES = 20
/** 返回给模型的 return 值上限（字符） */
const MAX_RESULT_CHARS = 12_000
/** 进度刷新节流：子代理密集时不要每条事件都推一次 SSE */
const PROGRESS_THROTTLE_MS = 400

export function createWorkflowTool(options: WorkflowToolOptions): AgentTool<typeof workflowToolSchema> {
  const limits = workflowLimitsOf(options.level)
  const levelLabel = options.level === 'max' ? '大档' : '标准档'
  return {
    name: 'workflow',
    label: '动态工作流',
    description:
      '用一段 JS 脚本编排多个子代理并行/流水线工作，适合需要拆解、并行调研、多角度交叉验证的复杂任务。' +
      `当前档位：${levelLabel}（最多 ${limits?.maxAgents ?? 0} 个子代理，默认并发 ${limits?.defaultConcurrency ?? 0}）。` +
      '脚本 API：await agent(prompt, { label, phase, schema }) 返回文本或结构化对象；' +
      'parallel([() => agent(...)]) 等全部完成；pipeline(items, 阶段1, 阶段2) 逐项串行跑各阶段；phase(title) 分组；log(msg) 记录。' +
      '失败的 agent 返回 null。脚本必须先用 export const meta = { name, description } 声明元信息。',
    parameters: workflowToolSchema,
    execute: async (
      _toolCallId: string,
      params: WorkflowToolArgs,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<{ progress: string }>
    ) => {
      if (!limits) throw new Error('动态工作流未开启：请先在设置里把工作流档位设为 standard 或 max')
      if (!params.script?.trim()) throw new Error('script 不能为空')

      const lines: string[] = []
      let started = 0
      let finished = 0
      let lastPush = 0
      // 第一行是实时状态（工作卡只显示首行），后面是过程日志
      const statusLine = (): string => `动态工作流 · 已启动 ${started} 个，完成 ${finished} 个`
      const pushProgress = (force: boolean): void => {
        if (!onUpdate) return
        const now = Date.now()
        if (!force && now - lastPush < PROGRESS_THROTTLE_MS) return
        lastPush = now
        const text = [statusLine(), ...lines].join('\n')
        onUpdate({ content: [{ type: 'text', text }], details: { progress: text } })
      }
      const addLine = (line: string): void => {
        lines.push(line)
        if (lines.length > MAX_PROGRESS_LINES) lines.splice(0, lines.length - MAX_PROGRESS_LINES)
      }

      const onEvent = (event: WorkflowEvent): void => {
        switch (event.type) {
          case 'phase_started':
            addLine(`▶ ${event.phase}`)
            // 阶段切换是重要节点，强制推一次
            pushProgress(true)
            return
          case 'agent_started':
            started += 1
            addLine(`… ${event.phase ? `[${event.phase}] ` : ''}${event.label}`)
            pushProgress(false)
            return
          case 'agent_done':
            finished += 1
            addLine(`${event.ok ? '✓' : '✗'} ${event.label}${event.ok ? '' : `（${event.detail ?? '失败'}）`}`)
            pushProgress(false)
            return
          case 'log':
            addLine(`· ${event.message}`)
            pushProgress(false)
            return
          default:
            return
        }
      }

      pushProgress(true)

      const result = await runWorkflow({
        script: params.script,
        args: params.args,
        maxConcurrency: params.maxConcurrency,
        level: options.level,
        cfg: options.cfg,
        target: options.target,
        signal: signal ?? new AbortController().signal,
        onEvent
      })

      const summary = formatResult(result)
      lines.push(summary.split('\n')[0]!)
      pushProgress(true)
      return {
        content: [{ type: 'text', text: summary }],
        details: {
          workflow: result.meta.name,
          status: result.stats.status,
          agentsRun: result.stats.agentsRun,
          agentsFailed: result.stats.agentsFailed,
          outputTokens: result.stats.outputTokens,
          durationMs: result.stats.durationMs
        }
      }
    }
  }
}

/** 最终结果文本：统计 + return 值（超长截断，避免把上下文撑爆） */
export function formatResult(result: WorkflowRunResult): string {
  const { meta, stats, returnValue } = result
  const head =
    stats.status === 'completed'
      ? `工作流「${meta.name}」完成：${stats.agentsRun} 个子代理（失败 ${stats.agentsFailed}），` +
        `输出 ${stats.outputTokens} tokens，用时 ${Math.round(stats.durationMs / 1000)}s`
      : `工作流「${meta.name}」${stats.status === 'aborted' ? '被取消' : '失败'}：${stats.error ?? '未知错误'}`

  let body: string
  try {
    body = returnValue === undefined ? '（脚本没有 return 值）' : JSON.stringify(returnValue, null, 2) ?? 'null'
  } catch {
    body = String(returnValue)
  }
  const truncated =
    body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n…（返回值已截断）` : body
  return `${head}\n\n脚本返回值：\n${truncated}`
}
