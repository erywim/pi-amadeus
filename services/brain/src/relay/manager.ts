import { HTTPException } from 'hono/http-exception'
import type { BrainConfig } from '../config.ts'
import { RelayClient, type RelayStatus } from './client.ts'

/** Relay 协议把连接码限制为 256-bit bearer secret 的 URL 安全形式。 */
const CONNECT_CODE = /^[A-Za-z0-9_-]{16,128}$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const MAX_REGISTRATION_KEY = 4096
const MAX_DEVICE_NAME = 80
const MAX_ERROR_LENGTH = 300

export interface RelayManagerStatus {
  /** 环境变量提供了完整且有效的 Relay 配置；不代表已经启用。 */
  configured: boolean
  /** 本次进程内已显式启用并持有 RelayClient；默认关闭。 */
  enabled: boolean
  serverUrl: string | null
  e2eEncryption: boolean
  deviceName: string
  state: RelayStatus['state']
  lastError: string | null
  connectedAt: number | null
  activeTunnels: number
}

export interface RelaySettingsInput {
  serverUrl?: string
  connectCode?: string
  registrationKey?: string
  e2eEncryption?: boolean
  deviceName?: string
  userId?: string
}

interface RelaySettings {
  serverUrl: string
  connectCode: string
  registrationKey: string
  e2eEncryption: boolean
  deviceName: string
  userId: string
  localPort: number
}

type RelayConfig = Pick<BrainConfig, 'port' | 'relay'>

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value)
}

/**
 * 校验并归一化 Relay 地址：生产环境只允许 https/wss；明文 http/ws 只允许
 * 本机回环，避免连接码与隧道内容经公网明文传输。
 */
function normalizeRelayUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol)) return null
  // 账号密码、查询串和片段都不属于 Relay 地址；拒绝它们，避免凭据藏在 URL 里。
  if (url.username || url.password || url.search || url.hash) return null
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && !LOOPBACK_HOSTS.has(url.hostname)) return null
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/** 每次启用都从环境变量重新解析；无效配置一律不下发客户端。 */
function resolveSettings(cfg: RelayConfig, overrides: RelaySettingsInput = {}): RelaySettings | null {
  const serverUrl = normalizeRelayUrl(overrides.serverUrl ?? cfg.relay.serverUrl)
  const connectCode = (overrides.connectCode ?? cfg.relay.connectCode).trim()
  if (!serverUrl || !CONNECT_CODE.test(connectCode)) return null
  const registrationKey = (overrides.registrationKey ?? cfg.relay.registrationKey).trim()
  if (registrationKey.length > MAX_REGISTRATION_KEY || hasControlCharacters(registrationKey)) return null
  const deviceName = (overrides.deviceName ?? cfg.relay.deviceName).trim()
  if (!deviceName || deviceName.length > MAX_DEVICE_NAME || hasControlCharacters(deviceName)) return null
  const userId = (overrides.userId ?? cfg.relay.userId).trim()
  if (!userId || userId.length > 128 || hasControlCharacters(userId)) return null
  const e2eEncryption = overrides.e2eEncryption ?? cfg.relay.e2eEncryption
  if (typeof e2eEncryption !== 'boolean') return null
  // Relay 客户端只会把手机请求转发到 127.0.0.1:cfg.port，端口必须可连接。
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) return null
  return {
    serverUrl,
    connectCode,
    registrationKey,
    e2eEncryption,
    deviceName,
    userId: (overrides.userId ?? cfg.relay.userId).trim(),
    localPort: cfg.port
  }
}

/** Brain 侧 Relay 生命周期：只由环境变量配置，默认关闭，所有迁移串行执行。 */
export class RelayManager {
  private readonly cfg: RelayConfig
  private client: RelayClient | null = null
  private activeSettings: RelaySettings | null = null
  private closed = false
  private lifecycle: Promise<void> = Promise.resolve()

  constructor(cfg: RelayConfig) {
    this.cfg = cfg
  }

  /**
   * 对外状态绝不包含连接码、注册密钥或 token hash；lastError 也脱敏，
   * 因为底层 socket 错误文本可能回显带凭据的 URL。
   */
  status(): RelayManagerStatus {
    const settings = this.activeSettings ?? resolveSettings(this.cfg)
    const raw = this.client?.status()
    return {
      configured: settings !== null,
      enabled: this.client !== null,
      serverUrl: settings?.serverUrl ?? null,
      e2eEncryption: settings?.e2eEncryption ?? this.cfg.relay.e2eEncryption,
      deviceName: settings?.deviceName ?? this.cfg.relay.deviceName,
      state: raw?.state ?? 'stopped',
      lastError: this.sanitize(raw?.lastError ?? null),
      connectedAt: raw?.connectedAt ?? null,
      activeTunnels: raw?.activeTunnels ?? 0
    }
  }

  /** 只在桌面端显式操作或 RELAY_ENABLED=true 时创建客户端；默认关闭。 */
  async enable(overrides: RelaySettingsInput = {}): Promise<RelayManagerStatus> {
    return this.transition(() => {
      if (this.closed) throw new HTTPException(503, { message: 'Relay 管理已随服务关闭' })
      // 已启用时保持幂等，不建立第二条隧道；换配置需先停用再启用。
      if (this.client) return this.status()
      const settings = resolveSettings(this.cfg, overrides)
      if (!settings) throw new HTTPException(409, { message: 'Relay 配置缺失或无效，请检查环境变量或输入' })
      const client = new RelayClient(settings)
      this.client = client
      this.activeSettings = settings
      try {
        client.start()
      } catch {
        // 启动失败回滚到未启用，避免状态显示 enabled 但实际没有连接。
        this.client = null
        this.activeSettings = null
        try { client.stop() } catch { /* 启动已失败，忽略重复关闭 */ }
        throw new HTTPException(500, { message: 'Relay 启动失败' })
      }
      return this.status()
    })
  }

  async disable(): Promise<void> {
    await this.transition(() => {
      const client = this.client
      this.client = null
      this.activeSettings = null
      try { client?.stop() } catch { /* 即使关闭异常也必须落到未启用 */ }
    })
  }

  async reconnect(): Promise<RelayManagerStatus> {
    return this.transition(() => {
      if (this.closed) throw new HTTPException(503, { message: 'Relay 管理已随服务关闭' })
      if (!this.client) throw new HTTPException(409, { message: 'Relay 尚未启用' })
      try {
        this.client.reconnect()
      } catch {
        throw new HTTPException(500, { message: 'Relay 重连失败' })
      }
      return this.status()
    })
  }

  /** HTTP 服务开始监听后调用；配置无效只记录脱敏警告，不影响大脑启动。 */
  async startIfEnabled(): Promise<void> {
    if (!this.cfg.relay.enabled) return
    try {
      await this.enable()
    } catch (error) {
      const message = error instanceof HTTPException ? error.message : '未知错误'
      console.warn(`[relay] 自动启动失败：${this.sanitize(message) ?? '未知错误'}`)
    }
  }

  /** 先置 closed 拒绝新的启用，再串行等待当前迁移结束并断开隧道。 */
  async shutdown(): Promise<void> {
    this.closed = true
    await this.transition(() => {
      const client = this.client
      this.client = null
      this.activeSettings = null
      try { client?.stop() } catch { /* 退出流程继续关闭数据库 */ }
    })
  }

  private transition<T>(operation: () => T | Promise<T>): Promise<T> {
    // 所有状态迁移排队执行：并发 enable/disable/reconnect 不能交错改写 client。
    const result = this.lifecycle.then(operation)
    this.lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  private sanitize(message: string | null): string | null {
    if (!message) return null
    let output = message.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
    for (const secret of [this.cfg.relay.connectCode, this.cfg.relay.registrationKey.trim()]) {
      if (secret.length >= 6) output = output.split(secret).join('[已隐藏]')
    }
    output = output
      .replace(/([?&](?:th|token|key|code)=)[^&\s]*/gi, '$1[已隐藏]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[已隐藏]')
    if (!output) return null
    return output.length > MAX_ERROR_LENGTH ? `${output.slice(0, MAX_ERROR_LENGTH)}…` : output
  }
}
