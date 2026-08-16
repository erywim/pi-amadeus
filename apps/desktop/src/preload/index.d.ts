export type DesktopApi = {
  getVersion: () => Promise<string>
  getPlatform: () => Promise<string>
  /** 在系统文件管理器中打开目录；返回空串=成功，非空=错误消息 */
  openPath: (path: string) => Promise<string>
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
