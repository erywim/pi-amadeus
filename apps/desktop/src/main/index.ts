import { app, ipcMain } from 'electron'
import { registerIpcHandlers } from './ipc'
import { setMenuLanguage } from './labels'
import { ProactiveWatcher } from './proactive'
import { AppTray } from './tray'
import { WindowManager } from './window-manager'
import { startBrain, stopBrain } from './brain-process'

// 开发期开 CDP 调试端口，供自动化 E2E 验证驱动。
// 命令行已指定时不覆盖（9222 被占用时可用 electron-vite dev --remoteDebuggingPort <port>）
if (!app.isPackaged && !app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

app.whenReady().then(async () => {
  await startBrain()
  const windows = new WindowManager()
  const tray = new AppTray(windows)
  const proactive = new ProactiveWatcher(windows)
  registerIpcHandlers(windows, proactive, (lang) => {
    if (setMenuLanguage(lang)) tray.refresh()
  })
  windows.onStateChange(() => tray.refresh())
  // 开发期 e2e 断言主进程窗口状态（打包产物不注册）
  if (!app.isPackaged) {
    ipcMain.handle('debug:state', () => ({ ...windows.debugState(), tray: tray.debugItems() }))
    ipcMain.handle('debug:pet-cursor', (_event, point: unknown) => {
      const p = point as { x?: unknown; y?: unknown } | null
      windows.debugSetPetCursor(p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null)
    })
    // 与托盘「鼠标穿透」同一个入口
    ipcMain.handle('debug:pet-passthrough', (_event, forced: unknown) => {
      if (typeof forced === 'boolean') windows.setPassthroughForced(forced)
    })
    // 主动问候：注入帧 / 模拟后台 / 指定 brain / 立即触发 / 读状态
    ipcMain.handle('debug:proactive', (_event, command: unknown) => proactive.debugCommand(command))
  }

  windows.createMainWindow()
  tray.create()
  // 主动问候调度：主进程不受隐藏窗口的定时器节流，后台/桌宠都靠它
  proactive.start()
  app.on('before-quit', () => proactive.stop())

  app.on('activate', (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) windows.showCurrent()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopBrain()
})
