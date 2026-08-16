import { app, ipcMain } from 'electron'

/** M1 最小 IPC 面：仅应用元信息。M2 起大脑服务以 HTTP/SSE 直连渲染层，不经 IPC 中转。 */
export function registerIpcHandlers(): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:platform', () => process.platform)
}
