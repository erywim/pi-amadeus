import { app, ipcMain, shell } from 'electron'

/** M1 最小 IPC 面：应用元信息 + 打开目录（skill 管理页）。其余大脑服务以 HTTP/SSE 直连渲染层。 */
export function registerIpcHandlers(): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:platform', () => process.platform)
  // 返回空串=成功；非空=错误消息（shell.openPath 契约）
  ipcMain.handle('shell:openPath', (_event, path: unknown) =>
    shell.openPath(typeof path === 'string' ? path : '')
  )
}
