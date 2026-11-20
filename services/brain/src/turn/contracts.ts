import type { ComputerRequest } from '@pi-amadeus/shared'

export interface TurnUsage {
  input: number
  output: number
  total: number
}

/** 内部执行事件：保留完整工具结果，传输层自行决定展示截断与字段映射。 */
export type TurnEvent =
  | { type: 'delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_update'; toolCallId: string; toolName: string; partial: string }
  | { type: 'tool_end'; toolCallId: string; toolName: string; isError: boolean; result: string; details: Record<string, unknown> }
  | { type: 'tool_confirm'; toolCallId: string; toolName: string; label: string; kind: 'bash' | 'computer'; args: Record<string, unknown>; expiresAt: number }
  | { type: 'approval_settled'; toolCallId: string }
  | ComputerRequest

export interface AgentExecutionResult {
  full: string
  lastText: string
  usage: TurnUsage
  toolNames: string[]
  aborted: boolean
}
