/** 应用模式：window=常规主窗口；pet=透明置顶的桌宠窗口 */
export type AppMode = 'window' | 'pet'

export type DesktopApi = {
  getVersion: () => Promise<string>
  getPlatform: () => Promise<string>
  /** 在系统文件管理器中打开目录；返回空串=成功，非空=错误消息 */
  openPath: (path: string) => Promise<string>
  /** 上报界面语言（原生托盘/右键菜单文案跟随） */
  setUiLanguage: (lang: string) => void
  getMode: () => Promise<AppMode>
  /** 请求切换模式（主进程完成切换后广播 onModeChanged） */
  setMode: (mode: AppMode) => void
  /** 订阅模式变化；返回取消订阅函数 */
  onModeChanged: (callback: (mode: AppMode) => void) => () => void
  /** 桌宠窗口专用 */
  pet: {
    /** 首帧已画完，可以显示 */
    ready: () => void
    /** 命中检测结果：true=光标在角色/对话框上，关闭鼠标穿透 */
    setInteractive: (interactive: boolean) => void
    /** 主进程轮询的全局光标（窗口内 CSS 像素，可能在窗口外）；返回取消订阅函数 */
    onCursor: (callback: (point: { x: number; y: number }) => void) => () => void
    /** 强制穿透开关变化（托盘「鼠标穿透」）；返回取消订阅函数 */
    onPassthrough: (callback: (forced: boolean) => void) => () => void
  }
  /** 仅开发构建：e2e 断言与驱动 */
  debug?: {
    /** 主进程窗口状态快照 */
    state: () => Promise<unknown>
    /** 用指定屏幕坐标代替真实光标（null 恢复） */
    petCursor: (point: { x: number; y: number } | null) => Promise<void>
    /** 与托盘「鼠标穿透」同一入口 */
    petPassthrough: (forced: boolean) => Promise<void>
  }
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
