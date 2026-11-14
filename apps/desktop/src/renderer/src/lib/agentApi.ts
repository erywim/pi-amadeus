import type {
  AgentOverview,
  AgentProfile,
  AgentProfileInput,
  AgentTask,
  AgentTaskEvent,
  AgentTaskInput,
  CollaborationPairing,
  CollaborationStatus,
  RelayStatus
} from '@pi-amadeus/shared'
import { BRAIN_URL } from './api'

export class AgentApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'AgentApiError'
  }
}

interface AgentsBridge {
  request: (path: string, method: string, body?: unknown) => Promise<{ status: number; body: unknown }>
  subscribe: (userId: string, after: number, onChunk: (chunk: string) => void, onEnd: () => void) => () => void
}

function bridge(): AgentsBridge | undefined {
  return (window.api as typeof window.api & { agents?: AgentsBridge } | undefined)?.agents
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const native = bridge()
  let status: number
  let payload: unknown
  if (native) {
    // 打包态 file:// 不直连：经受限 preload 桥避开 Origin:null，浏览器开发态仍走 HTTP。
    const response = await native.request(path, method, body)
    status = response.status
    payload = response.body
  } else {
    const response = await fetch(`${BRAIN_URL}${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    })
    status = response.status
    payload = status === 204 ? undefined : await response.json().catch(() => undefined)
  }
  if (status < 200 || status >= 300) {
    const error = payload as { error?: unknown; message?: unknown } | undefined
    const message = typeof error?.error === 'string' ? error.error :
      typeof error?.message === 'string' ? error.message : `HTTP ${status}`
    throw new AgentApiError(message, status)
  }
  if (status !== 204 && payload === undefined) throw new AgentApiError('Invalid JSON response', status)
  return payload as T
}

const taskPath = (id: string): string => `/api/agents/tasks/${encodeURIComponent(id)}`
const userQuery = (userId: string): string => new URLSearchParams({ userId }).toString()

export function fetchAgentOverview(userId: string): Promise<AgentOverview> {
  return request(`/api/agents?${userQuery(userId)}`)
}

export async function fetchAgentTask(id: string, userId: string): Promise<AgentTask> {
  return (await request<{ task: AgentTask }>(`${taskPath(id)}?${userQuery(userId)}`)).task
}

export async function createAgentTask(input: AgentTaskInput): Promise<AgentTask> {
  return (await request<{ task: AgentTask }>('/api/agents/tasks', 'POST', input)).task
}

export interface AgentTaskActionInput {
  userId: string
  prompt?: string
  requestId?: string
  agentId?: string
  approved?: boolean
  turnId?: string
  toolCallId?: string
}

export async function runAgentTaskAction(
  id: string,
  action: 'stop' | 'resume' | 'approve',
  input: AgentTaskActionInput
): Promise<AgentTask> {
  return (await request<{ task: AgentTask }>(`${taskPath(id)}/${action}`, 'POST', input)).task
}

export async function updateAgentTaskPosition(
  task: Pick<AgentTask, 'id' | 'userId' | 'revision'>,
  position: AgentTask['position']
): Promise<AgentTask> {
  return (await request<{ task: AgentTask }>(`${taskPath(task.id)}/position`, 'PATCH', {
    userId: task.userId,
    position,
    revision: task.revision
  })).task
}

export async function saveAgentProfile(input: AgentProfileInput, id?: string): Promise<AgentProfile> {
  const path = `/api/agents/profiles${id ? `/${encodeURIComponent(id)}` : ''}`
  return (await request<{ profile: AgentProfile }>(path, id ? 'PATCH' : 'POST', input)).profile
}

export async function deleteAgentProfile(id: string): Promise<void> {
  await request(`/api/agents/profiles/${encodeURIComponent(id)}`, 'DELETE')
}

/** 两个传输共用 SSE 分帧；跨 chunk 的 UTF-8/多行 data 不丢字节。 */
export function createAgentEventParser(onEvent: (event: AgentTaskEvent) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n')
      if (!data) continue
      try {
        const event = JSON.parse(data) as AgentTaskEvent
        if (Number.isSafeInteger(event.seq) && typeof event.taskId === 'string' &&
            ['status', 'output', 'tool', 'approval', 'position'].includes(event.type)) onEvent(event)
      } catch {
        // 心跳或不完整事件不推进游标；下一次快照仍可恢复真实任务。
      }
    }
  }
}

/** 取消订阅只停止观察，绝不向服务端发停止任务请求。 */
export function subscribeAgentEvents(
  userId: string,
  after: number,
  onEvent: (event: AgentTaskEvent) => void,
  onOpen: () => void,
  onError: () => void
): () => void {
  const parse = createAgentEventParser(onEvent)
  const native = bridge()
  if (native) return native.subscribe(userId, after, (chunk) => { onOpen(); parse(chunk) }, onError)
  const controller = new AbortController()
  const params = new URLSearchParams({ userId, after: String(after) })
  void (async () => {
    const response = await fetch(`${BRAIN_URL}/api/agents/events?${params.toString()}`, { signal: controller.signal })
    if (!response.ok || !response.body) throw new AgentApiError(`HTTP ${response.status}`, response.status)
    onOpen()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parse(decoder.decode(value, { stream: true }))
      }
      parse(decoder.decode())
    } finally {
      reader.releaseLock()
    }
    if (!controller.signal.aborted) onError()
  })().catch(() => { if (!controller.signal.aborted) onError() })
  return () => controller.abort()
}

export function fetchCollaborationStatus(userId: string): Promise<CollaborationStatus> {
  return request(`/api/collaboration/status?${userQuery(userId)}`)
}

export async function setCollaborationEnabled(enabled: boolean): Promise<void> {
  await request(`/api/collaboration/${enabled ? 'enable' : 'disable'}`, 'POST', enabled ? { port: 3003 } : {})
}

export function createCollaborationPairing(
  userId: string,
  role: CollaborationPairing['role']
): Promise<CollaborationPairing> {
  return request('/api/collaboration/pairing', 'POST', { userId, role })
}

export async function revokeCollaborationDevice(id: string, userId: string): Promise<void> {
  await request(`/api/collaboration/devices/${encodeURIComponent(id)}?${userQuery(userId)}`, 'DELETE')
}

/** 只在当前请求里提交的 Relay 连接参数；响应状态永远不含连接码或注册密钥。 */
export interface RelayEnableInput {
  serverUrl?: string
  connectCode?: string
  registrationKey?: string
  e2eEncryption?: boolean
  deviceName?: string
  userId?: string
}

export function fetchRelayStatus(): Promise<RelayStatus> {
  return request('/api/relay/status')
}

export function enableRelay(input: RelayEnableInput = {}): Promise<RelayStatus> {
  return request('/api/relay/enable', 'POST', input)
}

export async function disableRelay(): Promise<void> {
  await request('/api/relay/disable', 'POST', {})
}

export function reconnectRelay(): Promise<RelayStatus> {
  return request('/api/relay/reconnect', 'POST', {})
}
