/** 多 Agent 控制台的持久化契约；与普通聊天回合的临时 StreamState 分开。 */
export type AgentRuntime = 'brain' | 'claude' | 'codex' | 'opencode' | 'pi' | 'gemini' | 'aider' | 'goose' | 'qwen' | 'copilot' | 'custom'
export type AgentTaskStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface AgentProfile {
  id: string
  name: string
  runtime: AgentRuntime
  /** custom 使用绝对可执行文件路径；不通过 shell 拼接。 */
  command: string
  args: string[]
  /** stdin 或独立 argv 元素替换 {prompt}，避免提示词变成 shell。 */
  promptMode: 'stdin' | 'argument'
  instructions: string
  model: string
  enabled: boolean
  allowRemote: boolean
  createdAt: number
  updatedAt: number
}
export type AgentProfileInput = Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>

export interface DiscoveredAgent {
  runtime: AgentRuntime
  name: string
  installed: boolean
  path: string | null
  version: string | null
  /** 内置适配器已提供启动命令；未安装不等于无法配置自定义适配器。 */
  supported: boolean
  note: string
}

export interface AgentTask {
  id: string
  userId: string
  agentId: string
  agentName: string
  runtime: AgentRuntime
  title: string
  prompt: string
  cwd: string
  status: AgentTaskStatus
  output: string
  error: string | null
  sessionId: string
  missionId: string
  parentTaskId: string | null
  resumeOf: string | null
  dependsOn: string[]
  position: { x: number; y: number }
  revision: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
  pendingApproval: { turnId: string; toolCallId: string; command: string; expiresAt: number } | null
}
export interface AgentTaskInput {
  userId: string
  agentId: string
  title: string
  prompt: string
  cwd: string
  missionId?: string
  parentTaskId?: string
  resumeOf?: string
  dependsOn?: string[]
  /** 防止网络重试重复启动收费任务。 */
  requestId: string
}
export interface AgentTaskEvent {
  seq: number
  taskId: string
  type: 'status' | 'output' | 'tool' | 'approval' | 'position'
  data: Record<string, unknown>
  createdAt: number
}
export interface AgentOverview {
  profiles: AgentProfile[]
  discovered: DiscoveredAgent[]
  tasks: AgentTask[]
  maxConcurrent: number
}

export interface CollaborationDevice {
  id: string
  name: string
  role: 'observer' | 'controller'
  userId: string
  createdAt: number
  lastSeenAt: number
  revokedAt: number | null
  online: boolean
}
export interface CollaborationStatus {
  enabled: boolean
  port: number
  urls: string[]
  devices: CollaborationDevice[]
  transport: 'http-lan'
}
export interface CollaborationPairing {
  code: string
  expiresAt: number
  role: 'observer' | 'controller'
}
