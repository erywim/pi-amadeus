import type { ComputerResult } from '@pi-amadeus/shared'
import type {
  AffinitySummary,
  InstalledPlugin,
  MemoryItem,
  MemoryKind,
  MemoryListResponse,
  Message,
  PlatformInput,
  PlatformItem,
  PluginListResponse,
  ProviderInput,
  ProviderItem,
  ProviderTestResult,
  Session,
  SseEvent,
  StatsResponse,
  UserConfig
} from '@pi-amadeus/shared'

/**
 * 大脑服务 HTTP/SSE 客户端。
 * 单一后端（services/brain），浏览器直连：开发默认 http://localhost:3002，
 * 可用 VITE_BRAIN_URL 覆盖。
 */

export const BRAIN_URL: string =
  (import.meta.env.VITE_BRAIN_URL as string | undefined) ?? 'http://localhost:3002'

// ---------- 身份 ----------

// 登录态
export interface CurrentUser{
  userId: string
  username: string 
}

/**
 * 当前登录用户
 * @param userId 
 * @returns 
 */
export async function fetchCurrentUser(): Promise<CurrentUser | null>{
  const res = await fetch(`${BRAIN_URL}/api/users/current`)
  if(!res.ok) 
    throw new Error(`读取登录态失败: Http ${res.status}`)

  const json = (await res.json()) as {user: {id:string;username:string} | null}
  return json.user ? {userId :json.user.id,username: json.user.username} : null 
}

/**
 * 登录，同名沿用旧身份，否则新建
 * @param userId 
 * @returns 
 */
export async function loginUser(username:string) : Promise<CurrentUser> {
    const res = await fetch(`${BRAIN_URL}/api/users/login`,{
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username})
    })
    if(!res.ok)
      throw new Error(`登录失败：Http ${res.status}`)
    return (await res.json()) as CurrentUser
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

export async function renameSessionApi(sessionId: string, title: string, userId: string): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    // 带上 userId：未落库的空会话由服务端按当前身份补建（首条消息才懒创建）
    body: JSON.stringify({ title, userId })
  })
  if (!res.ok) throw new Error(`会话重命名失败: HTTP ${res.status}`)
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
  endpoint: '/api/chat' | '/api/chat/regenerate' | '/api/voice',
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

/**
 * 重新生成最后一条回复：服务端定位会话末尾的用户消息并替换旧助手回复。
 * 不携带 content——重新生成的是已有的那条提问，不是新问题。
 */
export function startRegenerate(
  body: { userId: string; sessionId: string },
  onEvent: (event: SseEvent) => void
): AbortController {
  return runTurn('/api/chat/regenerate', body, onEvent)
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
export async function confirmComputer(input: ComputerResult): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/desktop-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(`computer 回执失败: HTTP ${res.status}`)
}

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

// ---------- 插件中心 ----------

async function readError(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text) as { error?: unknown }
    if (typeof json.error === 'string') return json.error
  } catch {
    /* 非 JSON 响应：退回状态码 */
  }
  return `${fallback}: HTTP ${res.status}`
}

export async function fetchPlugins(): Promise<PluginListResponse> {
  const res = await fetch(`${BRAIN_URL}/api/plugins`)
  if (!res.ok) throw new Error(await readError(res, '插件列表失败'))
  return (await res.json()) as PluginListResponse
}

export async function installPluginApi(
  id: string,
  fields?: Record<string, string>
): Promise<InstalledPlugin> {
  const res = await fetch(`${BRAIN_URL}/api/plugins/${encodeURIComponent(id)}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields ?? {} })
  })
  if (!res.ok) throw new Error(await readError(res, '插件安装失败'))
  const json = (await res.json()) as { plugin: InstalledPlugin }
  return json.plugin
}

export async function uninstallPluginApi(id: string): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res, '插件卸载失败'))
}

export async function setPluginEnabledApi(id: string, enabled: boolean): Promise<InstalledPlugin> {
  const res = await fetch(`${BRAIN_URL}/api/plugins/${encodeURIComponent(id)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  })
  if (!res.ok) throw new Error(await readError(res, '插件启停失败'))
  const json = (await res.json()) as { plugin: InstalledPlugin }
  return json.plugin
}

export async function reconnectPluginApi(id: string): Promise<InstalledPlugin> {
  const res = await fetch(`${BRAIN_URL}/api/plugins/${encodeURIComponent(id)}/reconnect`, {
    method: 'POST'
  })
  if (!res.ok) throw new Error(await readError(res, 'MCP 重连失败'))
  const json = (await res.json()) as { plugin: InstalledPlugin }
  return json.plugin
}

export async function addCustomMcpApi(input: {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}): Promise<InstalledPlugin> {
  const res = await fetch(`${BRAIN_URL}/api/mcp/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(await readError(res, '添加 MCP 服务失败'))
  const json = (await res.json()) as { plugin: InstalledPlugin }
  return json.plugin
}

// ---------- 长期记忆与好感度 ----------

export async function fetchMemories(userId: string, query = ''): Promise<MemoryListResponse> {
  const params = new URLSearchParams({ userId })
  if (query.trim()) params.set('q', query.trim())
  const res = await fetch(`${BRAIN_URL}/api/memories?${params.toString()}`)
  if (!res.ok) throw new Error(await readError(res, '记忆加载失败'))
  return (await res.json()) as MemoryListResponse
}

export async function addMemoryApi(
  userId: string,
  content: string,
  kind: MemoryKind
): Promise<MemoryItem> {
  const res = await fetch(`${BRAIN_URL}/api/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, content, kind })
  })
  if (!res.ok) throw new Error(await readError(res, '新增记忆失败'))
  const json = (await res.json()) as { memory: MemoryItem }
  return json.memory
}

export async function updateMemoryApi(
  id: string,
  patch: { content?: string; kind?: MemoryKind; pinned?: boolean }
): Promise<MemoryItem> {
  const res = await fetch(`${BRAIN_URL}/api/memories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
  if (!res.ok) throw new Error(await readError(res, '更新记忆失败'))
  const json = (await res.json()) as { memory: MemoryItem }
  return json.memory
}

export async function deleteMemoryApi(id: string): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res, '删除记忆失败'))
}

export async function fetchAffinity(userId: string): Promise<AffinitySummary> {
  const res = await fetch(`${BRAIN_URL}/api/affinity?userId=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(await readError(res, '好感度加载失败'))
  return (await res.json()) as AffinitySummary
}

// ---------- 多模型服务 ----------

export async function fetchProviders(): Promise<ProviderItem[]> {
  const res = await fetch(`${BRAIN_URL}/api/providers`)
  if (!res.ok) throw new Error(await readError(res, '模型服务加载失败'))
  const json = (await res.json()) as { providers: ProviderItem[] }
  return json.providers
}

export async function createProviderApi(input: ProviderInput): Promise<ProviderItem> {
  const res = await fetch(`${BRAIN_URL}/api/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(await readError(res, '新增模型服务失败'))
  const json = (await res.json()) as { provider: ProviderItem }
  return json.provider
}

export async function updateProviderApi(id: string, input: ProviderInput): Promise<ProviderItem> {
  const res = await fetch(`${BRAIN_URL}/api/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(await readError(res, '更新模型服务失败'))
  const json = (await res.json()) as { provider: ProviderItem }
  return json.provider
}

export async function deleteProviderApi(id: string): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res, '删除模型服务失败'))
}

export async function activateProviderApi(id: string): Promise<ProviderItem> {
  const res = await fetch(`${BRAIN_URL}/api/providers/${encodeURIComponent(id)}/active`, {
    method: 'PUT'
  })
  if (!res.ok) throw new Error(await readError(res, '激活模型服务失败'))
  const json = (await res.json()) as { provider: ProviderItem }
  return json.provider
}

export async function testProviderApi(id: string): Promise<ProviderTestResult> {
  const res = await fetch(`${BRAIN_URL}/api/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST'
  })
  if (!res.ok) throw new Error(await readError(res, '连通性测试失败'))
  return (await res.json()) as ProviderTestResult
}

// ---------- 通讯平台 ----------

export async function fetchPlatforms(): Promise<PlatformItem[]> {
  const res = await fetch(`${BRAIN_URL}/api/platforms`)
  if (!res.ok) throw new Error(await readError(res, '通讯平台加载失败'))
  const json = (await res.json()) as { platforms: PlatformItem[] }
  return json.platforms
}

export async function createPlatformApi(input: PlatformInput): Promise<PlatformItem> {
  const res = await fetch(`${BRAIN_URL}/api/platforms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(await readError(res, '新增通讯平台失败'))
  const json = (await res.json()) as { platform: PlatformItem }
  return json.platform
}

export async function updatePlatformApi(
  id: string,
  input: { name?: string; enabled?: boolean; config?: Record<string, string> }
): Promise<PlatformItem> {
  const res = await fetch(`${BRAIN_URL}/api/platforms/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(await readError(res, '更新通讯平台失败'))
  const json = (await res.json()) as { platform: PlatformItem }
  return json.platform
}

export async function deletePlatformApi(id: string): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/platforms/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res, '删除通讯平台失败'))
}

export async function setPlatformEnabledApi(id: string, enabled: boolean): Promise<PlatformItem> {
  const res = await fetch(`${BRAIN_URL}/api/platforms/${encodeURIComponent(id)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  })
  if (!res.ok) throw new Error(await readError(res, '通讯平台启停失败'))
  const json = (await res.json()) as { platform: PlatformItem }
  return json.platform
}

export async function testPlatformApi(id: string): Promise<void> {
  const res = await fetch(`${BRAIN_URL}/api/platforms/${encodeURIComponent(id)}/test`, {
    method: 'POST'
  })
  if (!res.ok) throw new Error(await readError(res, '测试消息发送失败'))
}

// ---------- 数据看板 ----------

export async function fetchStats(userId: string, days = 14): Promise<StatsResponse> {
  const res = await fetch(
    `${BRAIN_URL}/api/stats?userId=${encodeURIComponent(userId)}&days=${encodeURIComponent(String(days))}`
  )
  if (!res.ok) throw new Error(await readError(res, '统计数据加载失败'))
  return (await res.json()) as StatsResponse
}
