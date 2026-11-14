import type { ProactiveMessageEvent } from '@pi-amadeus/shared'

/** 应用模式：window=常规主窗口；pet=透明置顶的桌宠窗口 */
import type { ComputerAction, ComputerExecutionResult } from '@pi-amadeus/shared'

export type AppMode = 'window' | 'pet'

/** 主动问候的配置补丁（字段由主进程逐个校验） */
export interface ProactiveConfigPatch {
  enabled?: boolean
  userId?: string | null
  sessionId?: string | null
  brainUrl?: string
  busy?: boolean
  modelKey?: string
}

export type DesktopApi = {
  getVersion: () => Promise<string>
  getPlatform: () => Promise<string>
  /** 在系统文件管理器中打开目录；返回空串=成功，非空=错误消息 */
  openPath: (path: string) => Promise<string>
  computer: {
    execute: (action: ComputerAction) => Promise<ComputerExecutionResult>
  }
  /** 上报界面语言（原生托盘/右键菜单文案跟随） */
  setUiLanguage: (lang: string) => void
  getMode: () => Promise<AppMode>
  /** 请求切换模式（主进程完成切换后广播 onModeChanged） */
  setMode: (mode: AppMode) => void
  /** 订阅模式变化；返回取消订阅函数 */
  onModeChanged: (callback: (mode: AppMode) => void) => () => void
  /** 原生管理桥：只允许本机工作台/设备接口，不暴露通用 HTTP 或 shell。 */
  agents: {
    request: (path: string, method: string, body?: unknown) => Promise<{ status: number; body: unknown }>
    subscribe: (userId: string, after: number, onChunk: (chunk: string) => void, onEnd: () => void) => () => void
  }
  /** 桌宠窗口专用 */
  pet: {
    /** 首帧已画完，可以显示 */
    ready: () => void
    /** 在光标处弹出桌宠右键菜单（回到窗口模式 / 鼠标穿透） */
    openMenu: () => void
    /** 命中检测结果：true=光标在角色/对话框上，关闭鼠标穿透 */
    setInteractive: (interactive: boolean) => void
    /** 兜底 logo 命中：强制穿透时也只有这里能接管鼠标 */
    setEscape: (escape: boolean) => void
    /** 开关强制穿透（兜底 logo 的菜单） */
    setPassthrough: (forced: boolean) => void
    /** 主进程轮询的全局光标（窗口内 CSS 像素，可能在窗口外）；返回取消订阅函数 */
    onCursor: (callback: (point: { x: number; y: number }) => void) => () => void
    /** 强制穿透开关变化（托盘「鼠标穿透」）；返回取消订阅函数 */
    onPassthrough: (callback: (forced: boolean) => void) => () => void
  }
  /** 主动问候：渲染层上报配置，主进程推回问候 */
  proactive: {
    setConfig: (patch: ProactiveConfigPatch) => void
    /** 屏幕录制权限（macOS）：granted / denied / restricted / not-determined / unknown */
    permission: () => Promise<string>
    /** 用户刚打开开关时触发一次系统授权（macOS）；返回触发后的权限状态 */
    requestPermission: () => Promise<string>
    /** 订阅主动问候（桌宠对话框 / 陪伴页展示）；返回取消订阅函数 */
    onMessage: (callback: (message: ProactiveMessageEvent) => void) => () => void
  }
  /** 仅开发构建：e2e 断言与驱动 */
  debug?: {
    /** 主进程窗口状态快照 */
    state: () => Promise<unknown>
    /** 用指定屏幕坐标代替真实光标（null 恢复） */
    petCursor: (point: { x: number; y: number } | null) => Promise<void>
    /** 与托盘「鼠标穿透」同一入口 */
    petPassthrough: (forced: boolean) => Promise<void>
    /** 主动问候：{ op: 'state' | 'trigger' | 'frame' | 'eligible' | 'brain', value? } */
    proactive: (command: Record<string, unknown>) => Promise<unknown>
  }
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
