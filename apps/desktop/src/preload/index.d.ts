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
  /** 桌宠窗口：首帧已画完，可以显示 */
  petReady: () => void
  /** 仅开发构建：主进程窗口状态快照（e2e 断言用） */
  debugState?: () => Promise<unknown>
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
