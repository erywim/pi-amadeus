import type { UserConfig, WorkflowLevel } from '@pi-amadeus/shared'

/**
 * 动态工作流的类型与档位参数（参考 Claude Code 的 Workflow 子系统，
 * 见 docs/dynamic-workflow.md）。与参考实现的主要差异：
 * - 脚本在本进程的 node:vm 沙箱里同步跑完（桌面端一次工具调用内完成），
 *   不是后台任务 + 通知；进度通过工具 onUpdate 事件实时上屏。
 * - 没有跨运行 journal 重放：每次工具调用都是全新运行。
 */

/** meta 块：与参考实现一致，必须是纯字面量 */
export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
}

/** 单个 agent() 的结果 */
export type AgentRunResult =
  | { kind: 'ok'; output: unknown; outputTokens: number }
  | { kind: 'dead'; reason: string; detail?: string }

/** 档位上限：standard 适合日常，max 适合大范围并行调研 */
export interface WorkflowLimits {
  /** 默认并发（脚本不传 maxConcurrency 时） */
  defaultConcurrency: number
  /** 并发硬上限（脚本传再大也 clamp 到这里） */
  maxConcurrency: number
  /** 一次运行最多真实执行多少个 agent() */
  maxAgents: number
  /** 一次运行的输出 token 预算（只统计成功 agent 的输出） */
  maxOutputTokens: number
  /** 一次运行的墙钟超时 */
  timeoutMs: number
  /** 脚本长度上限（字符） */
  maxScriptChars: number
}

export const WORKFLOW_LIMITS: Record<Exclude<WorkflowLevel, 'off'>, WorkflowLimits> = {
  standard: {
    defaultConcurrency: 3,
    maxConcurrency: 6,
    maxAgents: 12,
    maxOutputTokens: 40_000,
    timeoutMs: 5 * 60_000,
    maxScriptChars: 20_000
  },
  max: {
    defaultConcurrency: 4,
    maxConcurrency: 10,
    maxAgents: 30,
    maxOutputTokens: 150_000,
    timeoutMs: 15 * 60_000,
    maxScriptChars: 40_000
  }
}

export function workflowLimitsOf(level: WorkflowLevel): WorkflowLimits | null {
  return level === 'off' ? null : WORKFLOW_LIMITS[level]
}

/** 工作流档位：配置缺省按 off（不注册工具、不注入手册）；非法值同样按 off */
export function workflowLevelOf(config: UserConfig | null): WorkflowLevel {
  const level = config?.workflow?.level
  return level === 'standard' || level === 'max' ? level : 'off'
}

/** 进度事件（引擎 → 工具 onUpdate → SSE tool_update） */
export type WorkflowEvent =
  | { type: 'phase_started'; phase: string }
  | { type: 'phase_done'; phase: string }
  | { type: 'agent_started'; agentId: number; label: string; phase?: string }
  | { type: 'agent_done'; agentId: number; label: string; ok: boolean; detail?: string }
  | { type: 'log'; message: string }

export interface WorkflowRunStats {
  status: 'completed' | 'failed' | 'aborted'
  agentsRun: number
  agentsFailed: number
  outputTokens: number
  durationMs: number
  error?: string
}

export interface WorkflowRunResult {
  meta: WorkflowMeta
  returnValue: unknown
  stats: WorkflowRunStats
}

/** 脚本里可以拿到的钩子（与参考实现同名同语义） */
export interface WorkflowHooks {
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>
  pipeline: <T, R>(
    items: readonly T[],
    ...stages: Array<(prev: unknown, item: T, index: number) => Promise<unknown>>
  ) => Promise<Array<R | null>>
  phase: (title: string) => void
  log: (message: string) => void
}
