import WebSocket from 'ws'
import { E2eSession, tokenHash } from './protocol.ts'

type JsonRecord = Record<string, unknown>
type RelayState = 'stopped' | 'connecting' | 'connected' | 'error' | 'replaced'
type FrameSender = (frame: JsonRecord) => void

export interface RelayClientConfig {
  serverUrl: string
  connectCode: string
  registrationKey: string
  localPort: number
  deviceName: string
  e2eEncryption: boolean
  /** Fixed owner for remote Agent API requests; never accepted from the phone. */
  userId?: string
  /**
   * 最高 Relay 协议版本，默认 2。协议 1 永远兼容：老 Relay 的 `registered`
   * 不带 `proto` 时客户端自动按协议 1 工作。
   */
  protocol?: number
}

interface HttpTunnel {
  abort: AbortController
}

interface StreamedBody {
  frame: JsonRecord
  abort: AbortController
  chunks: Uint8Array[]
  size: number
  failed: boolean
}

interface E2eTunnel {
  session: E2eSession | null
  http: Map<string, HttpTunnel>
  sockets: Map<string, SocketTunnel>
  closed: boolean
}

interface SocketTunnel {
  socket: WebSocket
}

export interface RelayStatus {
  enabled: boolean
  serverUrl: string
  e2eEncryption: boolean
  state: RelayState
  lastError: string | null
  connectedAt: number | null
  activeTunnels: number
}

const REGISTER_TIMEOUT_MS = 20_000
const HEARTBEAT_MS = 15_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const MAX_BODY_BYTES = 128 * 1024 * 1024
const RESPONSE_CHUNK_BYTES = 32 * 1024
const CLIENT_MAX_PROTOCOL = 2
const DEFAULT_CLIENT_PROTOCOL = 2
const MAX_PATH_LENGTH = 8 * 1024
const HEADER_VALUE_LIMIT = 16 * 1024
const MAX_DECODE_PASSES = 4
const E2E_PATH = '/__alma_e2e__'

/**
 * 标记「这条请求来自 Relay 隧道」。手机不能伪造：客户端先把同名请求头
 * 丢掉，再写入自己的值。Brain 侧可据此拒绝对本机管理路径的远程访问。
 */
export const RELAY_ORIGIN_HEADER = 'x-amadeus-relay-origin'
export const RELAY_ORIGIN_VALUE = '1'

/** Relay 二进制帧类型（协议 2），见 services/relay/PROTOCOL.md。 */
export const BINARY_FRAME = Object.freeze({
  HCHUNK: 1,
  HBODY: 2,
  WBIN: 3,
  WTEXT: 4
})

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH'])
/** 远程隧道只开放 Agent 工作台和健康检查；不要把它变成任意本机 API 代理。 */
const REMOTE_PATHS = ['/api/health', '/api/agents', '/api/agents/events']
const TASK_PATH = /^\/api\/agents\/tasks\/[^/]+(?:\/(?:stop|resume|approve|position))?$/
/** 这些路径能改写 Relay / 协作网关本身，或改变谁可以配对，必须只留给本机桌面端。 */
const LOCAL_ADMIN_PREFIXES = ['/api/relay', '/api/collaboration', '/api/mobile-relay']
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'expect',
  'authorization',
  'proxy-authorization',
  'proxy-connection',
  'cookie',
  RELAY_ORIGIN_HEADER
])

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

/** 控制字符在 URL / 请求头里没有合法用途，出现即拒绝。 */
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * 协议 1 的 `hreq.b` / `wmsg.b` 是 base64 文本，不是字节。
 * 同时接受标准 base64 与 base64url（手机端 E2E 帧用后者），拒绝夹带
 * 空白或非法字符的输入。
 */
export function decodeRelayBase64(value: unknown): Uint8Array | null {
  if (value === undefined || value === null) return null
  const direct = asBytes(value)
  if (direct) return new Uint8Array(direct)
  if (typeof value !== 'string') return null
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null
  if (normalized.includes('=')) {
    if (normalized.length % 4 !== 0) return null
  } else if (normalized.length % 4 === 1) {
    return null
  }
  try {
    return new Uint8Array(Buffer.from(normalized, 'base64'))
  } catch {
    return null
  }
}

function frameBody(value: unknown): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined
  const bytes = decodeRelayBase64(value)
  if (!bytes) throw new Error('Relay 请求体不是合法的 base64')
  return bytes
}

function decodePathForPolicy(pathname: string): string {
  let decoded = pathname
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      throw new Error('Relay 请求路径编码无效')
    }
    if (next === decoded) return decoded
    decoded = next
  }
  return decoded
}

/** 把路径解到同一形态再判断，防止 `%2e%2e`、`%2f`、`//`、反斜杠绕过前缀检查。 */
function policyPath(pathname: string): string {
  const decoded = decodePathForPolicy(pathname)
  if (hasControlCharacters(decoded)) throw new Error('Relay 请求路径包含控制字符')
  const segments: string[] = []
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`.toLowerCase()
}

/**
 * 校验并归一化一条要转发给本机 Brain 的路径。
 * 只允许 `/api/...`，并拒绝所有解析形态下的本机管理路径。
 */
export function localRelayPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new Error('Relay 请求路径无效')
  }
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('#') ||
    hasControlCharacters(value)
  ) {
    throw new Error('Relay 请求路径无效')
  }
  let url: URL
  try {
    url = new URL(value, 'http://127.0.0.1')
  } catch {
    throw new Error('Relay 请求路径无效')
  }
  if (url.origin !== 'http://127.0.0.1' || url.username || url.password) {
    throw new Error('Relay 请求路径无效')
  }
  const checked = policyPath(url.pathname)
  const allowed = REMOTE_PATHS.includes(checked) || checked === '/api/agents' || TASK_PATH.test(checked)
  if (!allowed) throw new Error('Relay 拒绝访问未公开的本机 API 路径')
  for (const prefix of LOCAL_ADMIN_PREFIXES) {
    if (checked === prefix || checked.startsWith(`${prefix}/`)) {
      throw new Error('Relay 拒绝访问本机管理路径')
    }
  }
  // 转发时使用 URL 归一化后的原始编码形态，不把解码后的路径交给 fetch。
  return `${url.pathname}${url.search}`
}

/**
 * 构造转发给本机 Brain 的请求头：丢弃 hop-by-hop、Host、用户凭据与
 * 用户自带的内部标记，再写入 Relay 来源标记和 identity 编码。
 */
export function relayRequestHeaders(input: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.length > HEADER_VALUE_LIMIT || hasControlCharacters(value)) continue
      const name = key.toLowerCase()
      if (!HEADER_NAME.test(name) || DROPPED_REQUEST_HEADERS.has(name)) continue
      // 转发头不能把 Relay 请求伪装成本机或反向代理请求。
      if (name === 'forwarded' || name.startsWith('x-forwarded-')) continue
      result[name] = value
    }
  }
  result['accept-encoding'] = 'identity'
  result[RELAY_ORIGIN_HEADER] = RELAY_ORIGIN_VALUE
  return result
}

function queryWithRelayUser(path: string, userId: string | undefined): string {
  if (!path.startsWith('/api/agents')) return path
  if (!userId) throw new Error('Relay 未绑定本机用户，拒绝访问 Agent API')
  const url = new URL(path, 'http://127.0.0.1')
  url.searchParams.delete('userId')
  url.searchParams.set('userId', userId)
  return `${url.pathname}${url.search}`
}

/** Agent 写接口把归属放在 JSON body；覆盖手机传入的 userId，避免跨用户操作。 */
function bindAgentBody(path: string, method: string, body: Uint8Array | undefined, userId: string | undefined): Uint8Array | undefined {
  if (!path.startsWith('/api/agents') || !['POST', 'PATCH'].includes(method)) return body
  if (!userId) throw new Error('Relay 未绑定本机用户，拒绝访问 Agent API')
  if (!body) throw new Error('Agent 请求缺少 JSON 请求体')
  let value: unknown
  try { value = JSON.parse(textDecoder.decode(body)) } catch { throw new Error('Agent 请求 JSON 无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 请求必须是 JSON 对象')
  return textEncoder.encode(JSON.stringify({ ...(value as Record<string, unknown>), userId }))
}

/** 本客户端能主动提出的最高协议；老 Relay 会把它降回自己支持的版本。 */
export function clientProtocolOffer(value: unknown = DEFAULT_CLIENT_PROTOCOL): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 1) return 1
  return Math.min(n, CLIENT_MAX_PROTOCOL)
}

/** `registered.proto` 的合法取值；协议 3 的 credit window 本客户端尚未实现，降到 2。 */
export function relayProtocolFor(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 2 ? Math.min(n, CLIENT_MAX_PROTOCOL) : 1
}

export interface RelayBinaryFrame {
  kind: number
  id: string
  data: Uint8Array
}

/** `[kind:u8][idLen:u8][id:utf8][payload]`，协议 2 的二进制帧。 */
export function parseRelayBinaryFrame(value: unknown): RelayBinaryFrame | null {
  const view = asBytes(value)
  if (!view || view.byteLength < 2) return null
  const kind = view[0]
  const idLength = view[1]
  if (kind === undefined || idLength === undefined) return null
  if (view.byteLength < 2 + idLength) return null
  return {
    kind,
    id: textDecoder.decode(view.subarray(2, 2 + idLength)),
    data: view.subarray(2 + idLength)
  }
}

function isE2ePath(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const query = value.indexOf('?')
  return (query === -1 ? value : value.slice(0, query)) === E2E_PATH
}

function requestMethod(frame: JsonRecord): string {
  const method = typeof frame.method === 'string' ? frame.method.toUpperCase() : 'GET'
  if (!ALLOWED_METHODS.has(method)) throw new Error('Relay 请求方法不被允许')
  return method
}

function closeCode(value: unknown): number {
  const n = Number(value)
  return n === 1000 || (n >= 3000 && n <= 4999) ? n : 1000
}

function closeReason(value: unknown): string {
  const input = typeof value === 'string' ? value : ''
  let output = ''
  for (const char of input) {
    if (Buffer.byteLength(output + char, 'utf8') > 120) break
    output += char
  }
  return output
}

function rawBytes(data: unknown): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]))
  if (data instanceof Uint8Array) return new Uint8Array(data)
  return new Uint8Array(data as ArrayBuffer)
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]!
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function sendTextResponse(sendFrame: FrameSender, id: string, status: number, message: string): void {
  const body = textEncoder.encode(message)
  sendFrame({ t: 'hres', id, status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  sendFrame({ t: 'hchunk', id, b: body })
  sendFrame({ t: 'hend', id })
}

/** Brain-side Alma Relay agent: outbound WSS + optional E2E responder to loopback Brain. */
export class RelayClient {
  private socket: WebSocket | null = null
  private state: RelayState = 'stopped'
  private lastError: string | null = null
  private connectedAt: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private registerTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private stopped = true
  private reconnectDelay = RECONNECT_MIN_MS
  private protocol = 1
  private readonly offerProtocol: number
  private readonly http = new Map<string, HttpTunnel>()
  private readonly streamedBodies = new Map<string, StreamedBody>()
  private readonly e2e = new Map<string, E2eTunnel>()
  private readonly sockets = new Map<string, SocketTunnel>()
  private readonly config: RelayClientConfig

  constructor(config: RelayClientConfig) {
    this.config = config
    this.offerProtocol = clientProtocolOffer(config.protocol)
  }

  status(): RelayStatus {
    return {
      enabled: Boolean(this.config.serverUrl && this.config.connectCode),
      serverUrl: this.config.serverUrl,
      e2eEncryption: this.config.e2eEncryption,
      state: this.state,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      activeTunnels: this.http.size + this.streamedBodies.size + this.e2e.size + this.sockets.size
    }
  }

  start(): void {
    if (!this.config.serverUrl || !this.config.connectCode || !this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.teardownTunnels()
    const socket = this.socket
    this.socket = null
    try { socket?.close(1000, 'Relay disabled') } catch { /* already closed */ }
    this.connectedAt = null
    this.setState('stopped')
  }

  reconnect(): void {
    if (this.stopped) return
    this.reconnectDelay = RECONNECT_MIN_MS
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    try { socket?.close(1000, 'Reconnecting') } catch { /* already closed */ }
    this.teardownTunnels()
    this.connectedAt = null
    this.connect()
  }

  private connect(): void {
    if (this.stopped) return
    this.setState('connecting')
    // 状态转移：每次新连接都从协议 1 起步，等 `registered` 再切到协商结果。
    this.protocol = 1
    const hash = tokenHash(this.config.connectCode, this.config.e2eEncryption)
    const base = this.config.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws')
    const socket = new WebSocket(`${base}/agent?th=${encodeURIComponent(hash)}`, { maxPayload: 32 * 1024 * 1024 })
    this.socket = socket
    let registrationTimedOut = false
    this.registerTimer = setTimeout(() => {
      this.registerTimer = null
      if (this.socket !== socket) return
      registrationTimedOut = true
      socket.terminate()
      this.onDisconnect('Relay 注册超时')
    }, REGISTER_TIMEOUT_MS)
    socket.on('open', () => {
      this.startHeartbeat(socket)
      this.send({
        t: 'register',
        tokenHash: hash,
        name: this.config.deviceName || 'pi-amadeus',
        proto: this.offerProtocol,
        ...(this.config.registrationKey ? { key: this.config.registrationKey } : {})
      })
    })
    socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          this.handleBinaryFrame(rawBytes(data))
          return
        }
        this.receive(JSON.parse(data.toString()) as JsonRecord)
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    })
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return
      this.socket = null
      this.stopHeartbeat()
      this.clearRegisterTimer()
      if (code === 4000) {
        this.teardownTunnels()
        this.connectedAt = null
        this.lastError = '另一个设备接管了同一 Relay 配对码'
        this.setState('replaced')
        return
      }
      if (registrationTimedOut) return
      this.onDisconnect(code === 1000 ? null : `Relay 连接关闭 (${code}${reason.length ? `: ${reason.toString()}` : ''})`)
    })
    socket.on('error', (error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
    })
  }

  private receive(frame: JsonRecord): void {
    switch (frame.t) {
      case 'registered':
        this.clearRegisterTimer()
        // 状态转移：connecting → connected；Relay 未给 `proto` 时按协议 1。
        this.protocol = relayProtocolFor(frame.proto)
        this.lastError = null
        this.connectedAt = Date.now()
        this.reconnectDelay = RECONNECT_MIN_MS
        this.setState('connected')
        return
      case 'error':
        this.lastError = String(frame.message ?? 'Relay error')
        return
      case 'hreq': {
        const id = String(frame.id ?? '')
        if (!id) return
        if (this.config.e2eEncryption) {
          // 安全边界：E2E 开启时明文 hreq 只可能来自 Relay 本身，按 PROTOCOL 回 403。
          sendTextResponse((output) => this.send(output), id, 403, '此桌面只接受端到端加密连接')
          return
        }
        if (frame.stream === true && (frame.b === undefined || frame.b === null)) {
          this.beginStreamedBody(id, frame)
          return
        }
        let body: Uint8Array | undefined
        try {
          body = frameBody(frame.b)
        } catch (error) {
          sendTextResponse((output) => this.send(output), id, 400, error instanceof Error ? error.message : '请求体无效')
          return
        }
        const abort = new AbortController()
        void this.handleHttp(frame, body, abort).catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error)
        })
        return
      }
      case 'hreqend': {
        const id = String(frame.id ?? '')
        const pending = this.streamedBodies.get(id)
        if (!pending) return
        this.streamedBodies.delete(id)
        if (pending.failed) return
        // 状态转移：等待流式请求体 → 请求体完整到达，开始转发本地请求。
        const body = concatChunks(pending.chunks)
        void this.handleHttp(pending.frame, body, pending.abort).catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error)
        })
        return
      }
      case 'hcancel': {
        const id = String(frame.id ?? '')
        const pending = this.streamedBodies.get(id)
        if (pending) {
          this.streamedBodies.delete(id)
          pending.abort.abort()
          return
        }
        const tunnel = this.http.get(id)
        if (tunnel) {
          this.http.delete(id)
          tunnel.abort.abort()
        }
        return
      }
      case 'wopen': {
        const id = String(frame.id ?? '')
        if (!id) return
        if (this.config.e2eEncryption) {
          if (isE2ePath(frame.path)) {
            this.openE2eTunnel(id)
          } else {
            this.send({ t: 'werr', id, message: '此桌面只接受端到端加密连接' })
          }
          return
        }
        let path: string
        try {
          path = localRelayPath(frame.path)
        } catch (error) {
          this.send({ t: 'werr', id, message: error instanceof Error ? error.message : 'Relay 请求路径无效' })
          return
        }
        this.openLocalSocket(id, path)
        return
      }
      case 'wmsg': {
        const id = String(frame.id ?? '')
        if (!id || (!this.e2e.has(id) && !this.sockets.has(id))) return
        const binary = decodeRelayBase64(frame.b)
        if (binary) {
          this.deliverSocketMessage(id, binary)
          return
        }
        if (typeof frame.s === 'string') this.deliverSocketMessage(id, frame.s)
        return
      }
      case 'wclose': {
        const id = String(frame.id ?? '')
        const e2e = this.e2e.get(id)
        if (e2e) {
          this.e2e.delete(id)
          this.destroyE2e(e2e)
          return
        }
        const socket = this.sockets.get(id)?.socket
        this.sockets.delete(id)
        try { socket?.close(closeCode(frame.code), closeReason(frame.reason)) } catch { /* already closed */ }
        return
      }
      default:
        return
    }
  }

  private handleBinaryFrame(data: Uint8Array): void {
    // 只有协商到协议 2 才解析二进制帧；协议 1 下收到二进制说明对端实现有误，忽略。
    if (this.protocol < 2) return
    const frame = parseRelayBinaryFrame(data)
    if (!frame) return
    switch (frame.kind) {
      case BINARY_FRAME.HBODY: {
        const pending = this.streamedBodies.get(frame.id)
        if (!pending || pending.failed) return
        const chunk = new Uint8Array(frame.data)
        pending.chunks.push(chunk)
        pending.size += chunk.byteLength
        if (pending.size > MAX_BODY_BYTES) {
          this.streamedBodies.delete(frame.id)
          pending.failed = true
          // 状态转移：流式请求体接收中 → 拒绝；Relay 收到 hend 后会停止上传。
          sendTextResponse((output) => this.send(output), frame.id, 413, '请求体超过 Relay 上限')
          return
        }
        // 立即归还上传额度：本客户端把请求体暂存在内存里，等 hreqend 后一次转发。
        this.send({ t: 'hack', id: frame.id, n: chunk.byteLength })
        return
      }
      case BINARY_FRAME.WBIN:
        this.deliverSocketMessage(frame.id, new Uint8Array(frame.data))
        return
      case BINARY_FRAME.WTEXT:
        this.deliverSocketMessage(frame.id, textDecoder.decode(frame.data))
        return
      default:
        return
    }
  }

  private beginStreamedBody(id: string, frame: JsonRecord): void {
    try {
      requestMethod(frame)
    } catch (error) {
      sendTextResponse((output) => this.send(output), id, 405, error instanceof Error ? error.message : '请求方法不允许')
      return
    }
    try {
      localRelayPath(frame.path)
    } catch (error) {
      sendTextResponse((output) => this.send(output), id, 403, error instanceof Error ? error.message : 'Relay 拒绝访问该路径')
      return
    }
    const previous = this.streamedBodies.get(id)
    if (previous) previous.abort.abort()
    this.streamedBodies.set(id, { frame, abort: new AbortController(), chunks: [], size: 0, failed: false })
  }

  private deliverSocketMessage(id: string, payload: Uint8Array | string): void {
    const e2e = this.e2e.get(id)
    if (e2e?.session) {
      e2e.session.receive(payload)
      return
    }
    const socket = this.sockets.get(id)?.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    try { socket.send(payload) } catch { /* close handler cleans up */ }
  }

  private async handleHttp(frame: JsonRecord, body: Uint8Array | undefined, abort: AbortController): Promise<void> {
    const id = String(frame.id ?? '')
    if (!id) return
    const previous = this.http.get(id)
    if (previous && previous.abort !== abort) previous.abort.abort()
    this.http.set(id, { abort })
    try {
      await this.proxyHttp(frame, (output) => this.send(output), body, abort)
    } finally {
      if (this.http.get(id)?.abort === abort) this.http.delete(id)
    }
  }

  /** 把一条已校验的 Relay 请求转发到 loopback Brain；外层与 E2E 共用。 */
  private async proxyHttp(
    frame: JsonRecord,
    sendFrame: FrameSender,
    body: Uint8Array | undefined,
    abort: AbortController
  ): Promise<void> {
    const id = String(frame.id ?? '')
    try {
      let method: string
      try {
        method = requestMethod(frame)
      } catch {
        sendTextResponse(sendFrame, id, 405, 'Relay 请求方法不被允许')
        return
      }
      let path: string
      try {
        path = queryWithRelayUser(localRelayPath(frame.path), this.config.userId)
      } catch (error) {
        sendTextResponse(sendFrame, id, 403, error instanceof Error ? error.message : 'Relay 拒绝访问该路径')
        return
      }
      let boundBody: Uint8Array | undefined
      try {
        boundBody = bindAgentBody(path, method, body, this.config.userId)
      } catch (error) {
        sendTextResponse(sendFrame, id, 403, error instanceof Error ? error.message : 'Relay 请求身份无效')
        return
      }
      if (boundBody && boundBody.byteLength > MAX_BODY_BYTES) {
        sendTextResponse(sendFrame, id, 413, '请求体超过 Relay 上限')
        return
      }
      const response = await fetch(`http://127.0.0.1:${this.config.localPort}${path}`, {
        method,
        headers: relayRequestHeaders(frame.headers),
        body: method === 'GET' || method === 'HEAD' ? undefined : boundBody,
        signal: abort.signal,
        redirect: 'manual'
      })
      if (abort.signal.aborted) return
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (!['connection', 'keep-alive', 'transfer-encoding'].includes(key.toLowerCase())) headers[key] = value
      })
      sendFrame({ t: 'hres', id, status: response.status, headers })
      if (response.body && method !== 'HEAD') {
        const reader = response.body.getReader()
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          if (abort.signal.aborted) return
          for (let offset = 0; offset < next.value.byteLength; offset += RESPONSE_CHUNK_BYTES) {
            sendFrame({ t: 'hchunk', id, b: next.value.subarray(offset, offset + RESPONSE_CHUNK_BYTES) })
          }
        }
      }
      sendFrame({ t: 'hend', id })
    } catch (error) {
      if (!abort.signal.aborted) {
        sendFrame({ t: 'herr', id, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  private openLocalSocket(id: string, path: string): void {
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${this.config.localPort}${path}`)
    } catch (error) {
      this.send({ t: 'werr', id, message: error instanceof Error ? error.message : '无法打开本机 WebSocket' })
      return
    }
    this.sockets.set(id, { socket })
    socket.on('open', () => this.send({ t: 'wopened', id }))
    socket.on('message', (data, isBinary) => {
      const bytes = rawBytes(data)
      this.send({ t: 'wmsg', id, ...(isBinary ? { b: bytes } : { s: textDecoder.decode(bytes) }) })
    })
    socket.on('close', (code, reason) => {
      if (this.sockets.delete(id)) this.send({ t: 'wclose', id, code, reason: closeReason(reason.toString()) })
    })
    socket.on('error', (error) => {
      if (socket.readyState === WebSocket.CONNECTING && this.sockets.delete(id)) {
        this.send({ t: 'werr', id, message: error.message })
      }
    })
  }

  private openE2eTunnel(id: string): void {
    const existing = this.e2e.get(id)
    if (existing) {
      this.e2e.delete(id)
      this.destroyE2e(existing)
    }
    const tunnel: E2eTunnel = { session: null, http: new Map(), sockets: new Map(), closed: false }
    const session = new E2eSession({
      code: this.config.connectCode,
      responder: true,
      send: (payload) => {
        if (tunnel.closed) return
        this.send(payload instanceof Uint8Array ? { t: 'wmsg', id, b: payload } : { t: 'wmsg', id, s: payload })
      },
      // 解密后的内层帧必须走独立的 responder 状态机，绝不能交给外层 receive，
      // 否则内层 id 会误操作外层 HTTP / WebSocket 隧道。
      onFrame: (frame) => this.handleE2eFrame(tunnel, frame),
      onError: (message) => {
        if (tunnel.closed) return
        this.e2e.delete(id)
        this.destroyE2e(tunnel)
        // 状态转移：E2E 握手/记录层失败 → 关闭手机侧桥接 socket，避免它继续向死隧道写数据。
        this.send({ t: 'wclose', id, code: 1011, reason: closeReason(message) })
      }
    })
    tunnel.session = session
    this.e2e.set(id, tunnel)
    this.send({ t: 'wopened', id })
  }

  private handleE2eFrame(tunnel: E2eTunnel, frame: JsonRecord): void {
    if (tunnel.closed || !tunnel.session) return
    const session = tunnel.session
    switch (frame.t) {
      case 'hreq': {
        const id = String(frame.id ?? '')
        if (!id) return
        if (frame.stream === true) {
          // 本客户端尚未在 E2E 内层广告 sb（流式请求体），收到即视为对端越界。
          session.sendFrame({ t: 'herr', id, message: 'E2E 隧道暂不支持流式请求体' })
          return
        }
        const body = asBytes(frame.b) ?? undefined
        const abort = new AbortController()
        const previous = tunnel.http.get(id)
        if (previous && previous.abort !== abort) previous.abort.abort()
        tunnel.http.set(id, { abort })
        void this.handleE2eHttp(tunnel, frame, body, abort).catch((error: unknown) => {
          if (!tunnel.closed) session.sendFrame({ t: 'herr', id, message: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      case 'hcancel': {
        const id = String(frame.id ?? '')
        const tunnelHttp = tunnel.http.get(id)
        if (tunnelHttp) {
          tunnel.http.delete(id)
          tunnelHttp.abort.abort()
        }
        return
      }
      case 'wopen': {
        const id = String(frame.id ?? '')
        if (id) this.openE2eSocket(tunnel, id, frame.path)
        return
      }
      case 'wmsg': {
        const id = String(frame.id ?? '')
        const socket = tunnel.sockets.get(id)?.socket
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        const binary = asBytes(frame.b)
        try {
          if (binary) socket.send(binary)
          else if (typeof frame.s === 'string') socket.send(frame.s)
        } catch { /* close handler cleans up */ }
        return
      }
      case 'wclose': {
        const id = String(frame.id ?? '')
        const socket = tunnel.sockets.get(id)?.socket
        tunnel.sockets.delete(id)
        try { socket?.close(closeCode(frame.code), closeReason(frame.reason)) } catch { /* already closed */ }
        return
      }
      default:
        // 内层未知帧 / hbody / hreqend / hrack 一律丢弃，不回流到外层。
        return
    }
  }

  private async handleE2eHttp(
    tunnel: E2eTunnel,
    frame: JsonRecord,
    body: Uint8Array | undefined,
    abort: AbortController
  ): Promise<void> {
    const id = String(frame.id ?? '')
    if (!id) return
    try {
      await this.proxyHttp(
        frame,
        (output) => {
          if (!tunnel.closed) tunnel.session?.sendFrame(output)
        },
        body,
        abort
      )
    } finally {
      if (tunnel.http.get(id)?.abort === abort) tunnel.http.delete(id)
    }
  }

  private openE2eSocket(tunnel: E2eTunnel, id: string, value: unknown): void {
    const sendFrame: FrameSender = (frame) => {
      if (!tunnel.closed) tunnel.session?.sendFrame(frame)
    }
    let path: string
    try {
      path = localRelayPath(value)
    } catch (error) {
      sendFrame({ t: 'werr', id, message: error instanceof Error ? error.message : 'Relay 请求路径无效' })
      return
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${this.config.localPort}${path}`)
    } catch (error) {
      sendFrame({ t: 'werr', id, message: error instanceof Error ? error.message : '无法打开本机 WebSocket' })
      return
    }
    tunnel.sockets.set(id, { socket })
    socket.on('open', () => sendFrame({ t: 'wopened', id }))
    socket.on('message', (data, isBinary) => {
      const bytes = rawBytes(data)
      sendFrame({ t: 'wmsg', id, ...(isBinary ? { b: bytes } : { s: textDecoder.decode(bytes) }) })
    })
    socket.on('close', (code, reason) => {
      if (tunnel.sockets.delete(id)) sendFrame({ t: 'wclose', id, code, reason: closeReason(reason.toString()) })
    })
    socket.on('error', (error) => {
      if (socket.readyState === WebSocket.CONNECTING && tunnel.sockets.delete(id)) {
        sendFrame({ t: 'werr', id, message: error.message })
      }
    })
  }

  private destroyE2e(tunnel: E2eTunnel): void {
    if (tunnel.closed) return
    // 状态转移：E2E 隧道 → closed；先停内层请求，再断开它打开的本机 socket。
    tunnel.closed = true
    for (const tunnelHttp of tunnel.http.values()) tunnelHttp.abort.abort()
    tunnel.http.clear()
    for (const tunnelSocket of tunnel.sockets.values()) {
      try { tunnelSocket.socket.close(1012, 'Relay connection lost') } catch { /* already closed */ }
    }
    tunnel.sockets.clear()
  }

  private send(frame: JsonRecord): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    // 空 Uint8Array 也必须编码成 `b: ''`，否则 JSON 会把字节数组序列化成对象。
    const output: JsonRecord = frame.b instanceof Uint8Array
      ? { ...frame, b: Buffer.from(frame.b).toString('base64') }
      : frame
    try {
      socket.send(JSON.stringify(output))
    } catch { /* close handler reconnects */ }
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      try { socket.ping() } catch { /* close handler reconnects */ }
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private clearRegisterTimer(): void {
    if (this.registerTimer) clearTimeout(this.registerTimer)
    this.registerTimer = null
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    this.clearRegisterTimer()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private onDisconnect(error: string | null): void {
    this.teardownTunnels()
    this.connectedAt = null
    if (error) {
      this.lastError = error
      this.setState('error')
    }
    if (this.stopped || this.state === 'replaced') return
    this.setState('connecting')
    const delayMs = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delayMs)
  }

  private teardownTunnels(): void {
    for (const tunnel of this.http.values()) tunnel.abort.abort()
    this.http.clear()
    for (const pending of this.streamedBodies.values()) pending.abort.abort()
    this.streamedBodies.clear()
    for (const tunnel of this.sockets.values()) {
      try { tunnel.socket.close(1012, 'Relay connection lost') } catch { /* already closed */ }
    }
    this.sockets.clear()
    for (const tunnel of this.e2e.values()) this.destroyE2e(tunnel)
    this.e2e.clear()
  }

  private setState(state: RelayState): void {
    this.state = state
  }
}
