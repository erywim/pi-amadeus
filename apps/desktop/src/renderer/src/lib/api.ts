import type { Message, Session, SseEvent, UserConfig } from '@pi-amadeus/shared'

/**
 * 大脑服务 HTTP/SSE 客户端。
 * 单一后端（services/brain），浏览器直连：开发默认 http://localhost:3002，
 * 可用 VITE_BRAIN_URL 覆盖。
 */

export const BRAIN_URL: string =
  (import.meta.env.VITE_BRAIN_URL as string | undefined) ?? 'http://localhost:3002'

// ---------- 身份 ----------

const USER_ID_KEY = 'amadeus_user_id'
const USERNAME_KEY = 'amadeus_username'

/** 本机用户身份：localStorage 持久；首次启动按用户名（登录屏输入）建档 */
export function getLocalUserId(): string | null {
  return localStorage.getItem(USER_ID_KEY)
}

export function getLocalUsername(): string {
  return localStorage.getItem(USERNAME_KEY) ?? 'amadeus-user'
}

export function setLocalUsername(username: string): void {
  localStorage.setItem(USERNAME_KEY, username)
}

/** 解析（或创建）服务端用户：返回稳定 userId 并落 localStorage */
export async function resolveUserId(username: string): Promise<string> {
  const cached = localStorage.getItem(USER_ID_KEY)
  if (cached) {
    // 校验缓存身份仍存在于服务端；404 = 数据库被重置（如换库 / 清库），丢弃后重建。
    // 网络错误照旧抛出，不清缓存（brain 不可达时保留身份是正确的）。
    const res = await fetch(`${BRAIN_URL}/api/users/${encodeURIComponent(cached)}`)
    if (res.status !== 404) return cached
    localStorage.removeItem(USER_ID_KEY)
  }
  const res = await fetch(`${BRAIN_URL}/api/users/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
  if (!res.ok) throw new Error(`用户建档失败: HTTP ${res.status}`)
  const json = (await res.json()) as { userId: string }
  localStorage.setItem(USER_ID_KEY, json.userId)
  return json.userId
}

// ---------- 会话 / 消息 REST ----------

export async function fetchSessions(userId: string): Promise<Session[]> {
  const res = await fetch(`${BRAIN_URL}/api/sessions?userId=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`会话列表失败: HTTP ${res.status}`)
  const json = (await res.json()) as { sessions: Session[] }
  return json.sessions
}

export async function fetchMessages(sessionId: string): Promise<Message[]> {
  const res = await fetch(`${BRAIN_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages`)
  if (!res.ok) throw new Error(`消息加载失败: HTTP ${res.status}`)
  const json = (await res.json()) as { messages: Message[] }
  return json.messages
}

export async function deleteSessionApi(sessionId: string): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE'
  })
  if (!res.ok) throw new Error(`会话删除失败: HTTP ${res.status}`)
}

// ---------- 用户配置（服务端 SQLite 单一来源） ----------

export type ApiKeyStatus = 'default' | 'custom' | 'none'

export interface UserConfigResponse {
  config: UserConfig
  keyStatus: ApiKeyStatus
}

/** 读取服务端配置；apiKey 永远是被掩码的（响应不回传完整密钥） */
export async function fetchUserConfig(userId: string): Promise<UserConfigResponse> {
  const res = await fetch(`${BRAIN_URL}/api/config/${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`配置读取失败: HTTP ${res.status}`)
  return (await res.json()) as UserConfigResponse
}

/** 保存配置；provider.apiKey 留空 = 保持服务端已有密钥不变 */
export async function saveUserConfig(userId: string, config: UserConfig): Promise<UserConfigResponse> {
  const res = await fetch(`${BRAIN_URL}/api/config/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`配置保存失败: HTTP ${res.status} ${text.slice(0, 120)}`)
  }
  return (await res.json()) as UserConfigResponse
}

// ---------- SSE ----------

interface TurnBody {
  userId: string
  sessionId: string
  content?: string
  text?: string
}

/**
 * 发起一个回合的 SSE 流。onEvent 按事件回调；返回 AbortController 用于中途停止。
 * 网络错误抛出；done 事件正常结束流；连接干净关闭但无 done/error 终止事件时
 * 按 error 事件通知（否则 streaming/pendingUser 等状态卡死）。
 */
function runTurn(
  endpoint: '/api/chat' | '/api/voice',
  body: TurnBody,
  onEvent: (event: SseEvent) => void
): AbortController {
  const controller = new AbortController()
  void (async () => {
    const res = await fetch(`${BRAIN_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`大脑服务 ${res.status}: ${text.slice(0, 120)}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    /** 是否已收到终止事件（done/error）；连接关闭而未见终止 = 大脑被杀/代理掐断 */
    let terminated = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            // 事件处理器的异常（如音频解码失败）不允许中断整条流，
            // 否则 done/后续事件会丢失
            try {
              const event = JSON.parse(payload) as SseEvent
              if (event.type === 'done' || event.type === 'error') terminated = true
              onEvent(event)
            } catch (error) {
              console.error('[sse] 事件处理异常：', error)
            }
          }
        }
      }
    }
    if (!terminated) {
      // 抛给下方 catch，走与 error 事件等价的清理出口（abort 时 catch 内已静默）
      throw new Error('连接中断：未收到回合终止事件')
    }
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return
    onEvent({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  })
  return controller
}

/** 文本回合（仅中文） */
export function startChatTurn(
  body: { userId: string; sessionId: string; content: string },
  onEvent: (event: SseEvent) => void
): AbortController {
  return runTurn('/api/chat', body, onEvent)
}

/** 语音回合（双语言 + TTS 音频） */
export function startVoiceTurn(
  body: { userId: string; sessionId: string; text: string },
  onEvent: (event: SseEvent) => void
): AbortController {
  return runTurn('/api/voice', body, onEvent)
}

// ---------- 工具确认回执 ----------

/** bash 工具确认卡的应答（tool_confirm 事件的回执） */
export async function confirmTool(input: {
  turnId: string
  toolCallId: string
  approved: boolean
}): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/tool-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(`确认提交失败: HTTP ${res.status}`)
}

// ---------- skill 管理 ----------

export interface SkillInfo {
  name: string
  description: string
  filePath: string
  enabled: boolean
  disableModelInvocation?: boolean
}

export interface SkillListResponse {
  dir: string
  skills: SkillInfo[]
}

/** skill 列表（文件形式，目录在服务端） */
export async function fetchSkills(): Promise<SkillListResponse> {
  const res = await fetch(`${BRAIN_URL}/api/skills`)
  if (!res.ok) throw new Error(`skill 列表失败: HTTP ${res.status}`)
  return (await res.json()) as SkillListResponse
}

/** 启停单个 skill（状态持久化在服务端 skill 目录内） */
export async function setSkillEnabledApi(name: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/skills/${encodeURIComponent(name)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  })
  if (!res.ok) throw new Error(`skill 启停失败: HTTP ${res.status}`)
}
