import { app, ipcMain } from 'electron'
import { registerIpcHandlers } from './ipc'
import { setMenuLanguage } from './labels'
import { AppTray } from './tray'
import { WindowManager } from './window-manager'

// 开发期开 CDP 调试端口，供自动化 E2E 验证驱动。
// 命令行已指定时不覆盖（9222 被占用时可用 electron-vite dev --remoteDebuggingPort <port>）
if (!app.isPackaged && !app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

app.whenReady().then(() => {
  const windows = new WindowManager()
  const tray = new AppTray(windows)
  registerIpcHandlers(windows, (lang) => {
    if (setMenuLanguage(lang)) tray.refresh()
  })
  windows.onModeChange(() => tray.refresh())
  // 开发期 e2e 断言主进程窗口状态（打包产物不注册）
  if (!app.isPackaged) {
    ipcMain.handle('debug:state', () => ({ ...windows.debugState(), tray: tray.debugItems() }))
  }

  windows.createMainWindow()
  tray.create()

  app.on('activate', (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) windows.showCurrent()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
