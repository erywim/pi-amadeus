import { desktopCapturer, Notification, screen, systemPreferences } from 'electron'
import type { Emotion, ProactiveMessageEvent, ProactiveVisionGreeting } from '@pi-amadeus/shared'
import type { WindowManager } from './window-manager'

/**
 * 主动问候调度器（主进程）。
 *
 * 条件：应用在后台（主窗口不可见 / 最小化 / 失焦）或处于桌宠模式。
 * 节奏：进入后台起算 10 分钟 + 0~5 分钟随机；每次问候后重新抽一次。
 * 动作：截当前桌面 → `POST {brain}/api/proactive`（视觉模型识别 + 落库）→
 *       系统通知 + 推给渲染层（桌宠对话框 / 陪伴页）。
 *
 * 为什么放在主进程而不是渲染层：
 * - 隐藏/后台的渲染层定时器会被 Chromium 节流，10~15 分钟的定时器不可靠；
 * - 截屏只有主进程的 desktopCapturer 拿得到，不需要用户每次选窗口；
 * - 主窗口在桌宠模式下已被隐藏，任何"只在某个窗口里跑"的调度都会随模式切换消失。
 *
 * 前台不截屏、不请求；正在对话（麦克风 / 语音回合 / 文本流）时也不打断，
 * 顺延 1 分钟再看。
 */

const BASE_INTERVAL_MS = 10 * 60_000
const JITTER_MAX_MS = 5 * 60_000
/** 前台 / 后台状态轮询：只读窗口状态，代价可忽略；决定"进入后台"的起算点 */
const POLL_MS = 30_000
/** 到点时正忙（或刚失败）的顺延间隔 */
const RETRY_MS = 60_000
/** 截屏不可用（未授权 / 无源）的顺延间隔：别每分钟撞一次系统权限 */
const CAPTURE_RETRY_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 90_000
/** 截屏长边：1280 宽的 JPEG 约 100~300KB，足够模型认出窗口类型 */
const CAPTURE_WIDTH = 1280
const CAPTURE_JPEG_QUALITY = 70

export interface ProactiveConfig {
  enabled: boolean
  userId: string | null
  sessionId: string | null
  brainUrl: string
  /** 非敏感模型身份；模型切换后解除 no_vision 暂停，不包含 API key */
  modelKey: string
  /** 渲染层上报：麦克风 / 语音回合 / 文本回合进行中，不打断 */
  busy: boolean
}

/** 触发结果（debug 状态与日志共用）：waiting=还没到点，delivered=已投递 */
export type ProactiveOutcome =
  | 'idle'
  | 'disabled'
  | 'no-user'
  | 'foreground'
  | 'waiting'
  | 'busy'
  | 'no-vision'
  | 'capturing'
  | 'delivered'
  | 'failed'

export type ScreenPermission = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface ProactiveStatus {
  enabled: boolean
  mode: 'window' | 'pet'
  busy: boolean
  hasUser: boolean
  hasSession: boolean
  eligible: boolean
  outcome: ProactiveOutcome
  lastError: string
  lastAt: number
  /** 下一次到点的 epoch ms；null=不在后台/未启用，还没起算 */
  nextDueAt: number | null
  /** 截屏权限（macOS 需要屏幕录制；其它平台恒为 granted） */
  screenPermission: ScreenPermission
  /** 已投递的问候次数与最近一次的通知数（e2e 断言通知确实发起过） */
  deliveredCount: number
  notifiedCount: number
  /** 当前平台是否支持系统通知（不支持时只推渲染层） */
  notificationSupported: boolean
  /** e2e：当前是否用注入帧代替真实截屏 */
  frameInjected: boolean
}

/** macOS 的屏幕录制权限：调用前先查，避免后台定时器反复弹系统授权 */
export function screenPermission(): ScreenPermission {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen') as ScreenPermission
}

/**
 * 用户刚在设置页打开「主动问候」时调用：macOS 只有应用真的尝试采集才会弹出授权、
 * 才会出现在"屏幕录制"列表里；后台定时器自己绝不会去撞这个系统弹窗。
 * 采集一块 1x1 的缩略图即可完成触发，不读真实画面。
 */
export async function requestScreenPermission(): Promise<ScreenPermission> {
  if (process.platform !== 'darwin') return 'granted'
  if (screenPermission() === 'granted') return 'granted'
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
  } catch {
    // 被拒绝/取消：权限状态保持不变，由设置页提示去系统设置
  }
  return screenPermission()
}

/** 抽一次间隔：10 分钟 + 0~5 分钟随机（issue 语义："10 分钟 ± 随机，最多 5"） */
function nextInterval(): number {
  return BASE_INTERVAL_MS + Math.floor(Math.random() * JITTER_MAX_MS)
}

/** 截当前光标所在显示器的桌面，返回 base64 JPEG；不可用返回 null */
async function captureScreenJpeg(): Promise<string | null> {
  if (screenPermission() !== 'granted') return null
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const scale = Math.min(1, CAPTURE_WIDTH / display.size.width)
  const thumbnailSize = {
    width: Math.max(1, Math.round(display.size.width * scale)),
    height: Math.max(1, Math.round(display.size.height * scale))
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false
  })
  if (sources.length === 0) return null
  // display_id 在部分平台/多屏下可能为空：退回第一块屏，总比不截强
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]!
  const image = source.thumbnail
  if (!image || image.isEmpty()) return null
  return image.toJPEG(CAPTURE_JPEG_QUALITY).toString('base64')
}

/** 校验渲染层上报的配置补丁：字段逐个按 unknown 处理，非法的忽略 */
export function parseProactiveConfigPatch(value: unknown): Partial<ProactiveConfig> | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const patch: Partial<ProactiveConfig> = {}
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled
  if (typeof raw.busy === 'boolean') patch.busy = raw.busy
  if (typeof raw.modelKey === 'string') patch.modelKey = raw.modelKey.slice(0, 512)
  const optionalString = (key: string, max: number): string | null | undefined => {
    const v = raw[key]
    if (v === null) return null
    return typeof v === 'string' ? v.slice(0, max) : undefined
  }
  const userId = optionalString('userId', 128)
  if (userId !== undefined) patch.userId = userId || null
  const sessionId = optionalString('sessionId', 128)
  if (sessionId !== undefined) patch.sessionId = sessionId || null
  if (typeof raw.brainUrl === 'string' && raw.brainUrl.length <= 2048) {
    try {
      const url = new URL(raw.brainUrl)
      // 只接受 HTTP(S)：渲染层给的是本地大脑地址，别让别的 scheme 混进 fetch
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        patch.brainUrl = url.toString().replace(/\/+$/, '')
      }
    } catch {
      /* 非法 URL：忽略该字段 */
    }
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export class ProactiveWatcher {
  private config: ProactiveConfig = {
    enabled: true,
    userId: null,
    sessionId: null,
    brainUrl: 'http://localhost:3002',
    modelKey: '',
    busy: false
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private nextDueAt: number | null = null
  private firing = false
  private outcome: ProactiveOutcome = 'idle'
  private lastError = ''
  /** 当前模型不支持视觉时暂停调度，直到渲染层上报模型/身份变化 */
  private noVisionKey: string | null = null
  private lastAt = 0
  private requestAbort: AbortController | null = null
  private deliveredCount = 0
  private notifiedCount = 0
  private loggedOutcome: string | null = null

  // 开发期 e2e 用：不碰真实桌面/真实服务
  private debugFrame: string | null = null
  private debugEligible: boolean | null = null
  private debugBrainUrl: string | null = null

  constructor(private readonly windows: WindowManager) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.evaluate().catch((error) => {
        console.warn('[proactive] 调度异常：', error instanceof Error ? error.message : error)
      })
    }, POLL_MS)
    void this.evaluate().catch(() => {})
  }

  stop(): void {
    this.requestAbort?.abort()
    this.requestAbort = null
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 渲染层上报的配置。enabled / userId 变化都会重置起算点：
   * 换了用户或刚打开开关时，不应该沿用上一个用户/上一段时间的到期时刻。
   */
  setConfig(patch: Partial<ProactiveConfig>): void {
    const prev = this.config
    this.config = { ...prev, ...patch }
    if (prev.enabled !== this.config.enabled || prev.userId !== this.config.userId) {
      this.nextDueAt = null
    }
    // 模型切换通过 brainUrl 变化时解除 no_vision；同一 URL 下的用户切换也解除。
    if (
      prev.userId !== this.config.userId ||
      prev.brainUrl !== this.config.brainUrl ||
      prev.modelKey !== this.config.modelKey
    ) {
      this.noVisionKey = null
    }
    if (
      prev.enabled !== this.config.enabled ||
      prev.userId !== this.config.userId ||
      prev.sessionId !== this.config.sessionId ||
      prev.brainUrl !== this.config.brainUrl ||
      prev.modelKey !== this.config.modelKey ||
      (!prev.busy && this.config.busy)
    ) {
      this.requestAbort?.abort()
    }
  }

  status(): ProactiveStatus {
    return {
      enabled: this.config.enabled,
      mode: this.windows.getMode(),
      busy: this.config.busy,
      hasUser: !!this.config.userId,
      hasSession: !!this.config.sessionId,
      eligible: this.debugEligible ?? this.isEligible(),
      outcome: this.outcome,
      lastError: this.lastError,
      lastAt: this.lastAt,
      nextDueAt: this.nextDueAt,
      screenPermission: screenPermission(),
      deliveredCount: this.deliveredCount,
      notifiedCount: this.notifiedCount,
      notificationSupported: Notification.isSupported(),
      frameInjected: this.debugFrame !== null
    }
  }

  /** 应用是否处在"可以主动搭话"的状态：桌宠模式，或主窗口在后台 */
  private isEligible(): boolean {
    return this.windows.getMode() === 'pet' || this.windows.isMainWindowBackgrounded()
  }

  /** 定时轮询：维护"进入后台 → 起算 → 到点 → 投递 → 重新抽间隔"的状态机 */
  private async evaluate(): Promise<void> {
    if (!this.config.enabled) {
      this.setState('disabled')
      this.nextDueAt = null
      return
    }
    if (!this.config.userId) {
      this.setState('no-user')
      this.nextDueAt = null
      return
    }
    if (!(this.debugEligible ?? this.isEligible())) {
      // 回到前台：清掉到期时刻，下次进入后台从头起算，不会立刻弹一条
      this.setState('foreground')
      this.nextDueAt = null
      return
    }
    if (this.noVisionKey !== null) {
      this.setState('no-vision')
      this.nextDueAt = null
      return
    }

    const now = Date.now()
    if (this.nextDueAt === null) {
      // 刚进入后台：从这一刻开始计时，第一条问候在 10~15 分钟后
      this.nextDueAt = now + nextInterval()
      this.setState('waiting')
      return
    }
    if (now < this.nextDueAt || this.firing) return
    if (this.config.busy) {
      // 用户正在对话：顺延一分钟再看，不打断也不重置整个 10~15 分钟
      this.nextDueAt = now + RETRY_MS
      this.setState('busy')
      return
    }
    await this.fire()
  }

  /** 立即试一次（跳过到期时刻，但仍受 enabled / 后台 / busy 约束）；e2e 与手动排查用 */
  async triggerNow(): Promise<ProactiveStatus> {
    if (!this.config.enabled) {
      this.setState('disabled')
      this.nextDueAt = null
      return this.status()
    }
    if (!this.config.userId) {
      this.setState('no-user')
      this.nextDueAt = null
      return this.status()
    }
    if (!(this.debugEligible ?? this.isEligible())) {
      this.setState('foreground')
      this.nextDueAt = null
      return this.status()
    }
    if (this.noVisionKey !== null) {
      this.setState('no-vision')
      this.nextDueAt = null
      return this.status()
    }
    if (this.config.busy) {
      this.setState('busy')
      this.nextDueAt = Date.now() + RETRY_MS
      return this.status()
    }
    if (this.firing) return this.status()
    // 调试触发不等到期时刻，直接投递；投递后照常从此刻重新抽 10~15 分钟
    this.nextDueAt = Date.now()
    await this.fire()
    return this.status()
  }

  /** 截屏 → 大脑生成 → 通知 + 推渲染层 */
  private async fire(): Promise<void> {
    if (this.firing) return
    this.firing = true
    const requestUserId = this.config.userId
    const requestSessionId = this.config.sessionId
    const requestBrainUrl = this.debugBrainUrl ?? this.config.brainUrl
    const startedAt = Date.now()
    const requestController = new AbortController()
    this.requestAbort = requestController
    try {
      this.setState('capturing')
      const frame = this.debugFrame ?? (await captureScreenJpeg())
      if (!frame) {
        // 未授权/无屏可截：不是错误路径，用户可能没给屏幕录制权限
        this.fail('截屏不可用（检查系统屏幕录制权限）', CAPTURE_RETRY_MS, startedAt)
        return
      }

      const res = await fetch(`${requestBrainUrl}/api/proactive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: requestUserId,
          ...(requestSessionId ? { sessionId: requestSessionId } : {}),
          frame
        }),
        signal: AbortSignal.any([
          requestController.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        ])
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        if (res.status === 422 && isNoVisionResponse(body)) {
          this.noVisionKey = `${requestUserId}|${requestSessionId ?? ''}|${requestBrainUrl}`
          this.lastError = '当前模型不支持图像输入，请在模型设置中切换视觉模型'
          this.nextDueAt = null
          this.setState('no-vision')
          return
        }
        const detail = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${res.status}`
        throw new Error(`大脑返回 ${res.status}：${detail.slice(0, 200)}`)
      }

      const greeting = parseGreeting(body)
      if (!greeting) throw new Error('大脑返回的问候格式不合法')
      // 请求期间用户/会话/地址改变，或用户回到前台/开始对话：丢弃旧问候，
      // 不把旧上下文的消息通知到新会话，也不让后台主动行为打断用户。
      const stale =
        requestUserId !== this.config.userId ||
        requestSessionId !== this.config.sessionId ||
        requestBrainUrl !== (this.debugBrainUrl ?? this.config.brainUrl) ||
        !this.config.enabled ||
        this.config.busy ||
        !(this.debugEligible ?? this.isEligible())
      if (stale) {
        this.setState('idle')
        return
      }

      this.lastAt = Date.now()
      this.lastError = ''
      this.deliveredCount += 1
      this.nextDueAt = this.lastAt + nextInterval()
      this.setState('delivered')
      this.deliver(greeting)
    } catch (error) {
      if (requestController.signal.aborted) {
        this.setState('idle')
        return
      }
      this.fail(error instanceof Error ? error.message : String(error), RETRY_MS, startedAt)
    } finally {
      if (this.requestAbort === requestController) this.requestAbort = null
      this.firing = false
    }
  }

  /** 失败：记下原因并顺延；同样的失败只打一次日志，避免后台每分钟刷屏 */
  private fail(message: string, retryMs: number, startedAt: number): void {
    this.lastError = message
    this.nextDueAt = Date.now() + retryMs
    this.lastAt = startedAt
    this.setState('failed')
  }

  /** 状态转移日志：只在结果变化时打，稳定等待/重复失败期间不刷屏 */
  private setState(outcome: ProactiveOutcome): void {
    this.outcome = outcome
    const key = outcome === 'failed' ? `failed:${this.lastError}` : outcome
    if (this.loggedOutcome === key) return
    this.loggedOutcome = key
    if (outcome === 'failed' || outcome === 'delivered') {
      const detail = outcome === 'failed' ? `：${this.lastError}` : ''
      console.log(`[proactive] ${outcome}${detail}`)
    }
  }

  /** 系统通知 + 推给两个渲染层（主窗口在后台也收，回来后能看到问候） */
  private deliver(greeting: ProactiveVisionGreeting): void {
    const event: ProactiveMessageEvent = { ...greeting, mode: this.windows.getMode() }
    for (const win of this.windows.listWindows()) {
      win.webContents.send('proactive:message', event)
    }
    if (Notification.isSupported()) {
      const notification = new Notification({ title: 'Amadeus', body: greeting.text })
      // 点通知回到当前模式的窗口：后台时把人带回对话，桌宠时只让角色露出
      notification.on('click', () => this.windows.showCurrent())
      notification.show()
      this.notifiedCount += 1
    }
  }

  // ---------- 开发期 e2e（仅 !app.isPackaged 时经 ipc 暴露） ----------

  debugCommand(command: unknown): ProactiveStatus | Promise<ProactiveStatus> {
    if (!command || typeof command !== 'object') return this.status()
    const { op, value } = command as { op?: unknown; value?: unknown }
    switch (op) {
      case 'state':
        return this.status()
      case 'trigger':
        return this.triggerNow()
      case 'frame':
        // 注入帧：e2e 不截真实桌面（也不依赖屏幕录制权限）
        this.debugFrame =
          typeof value === 'string' && value.length > 0 && value.length < 8 * 1024 * 1024
            ? value
            : null
        return this.status()
      case 'eligible':
        this.debugEligible = typeof value === 'boolean' ? value : null
        return this.status()
      case 'brain':
        this.debugBrainUrl =
          typeof value === 'string' && /^https?:\/\//.test(value) ? value.replace(/\/+$/, '') : null
        return this.status()
      default:
        return this.status()
    }
  }
}

/** 视觉能力不可用是配置问题，不是网络故障；同一配置下暂停重复截屏。 */
function isNoVisionResponse(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'no_vision'
}

/** 严格解析大脑响应：缺字段/空正文一律当失败，不让半截数据变成一条通知 */
function parseGreeting(body: unknown): ProactiveVisionGreeting | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
  const messageId = typeof raw.messageId === 'string' ? raw.messageId : ''
  if (!text || !sessionId || !messageId) return null
  return {
    sessionId,
    messageId,
    text,
    // 情绪值由大脑按 EMOTIONS 校验过；这里只做类型收窄，非法字符串当作没有情绪
    emotion: typeof raw.emotion === 'string' ? (raw.emotion as Emotion) : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  }
}
