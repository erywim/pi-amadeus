import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { registerIpcHandlers } from './ipc'

// 允许交给系统打开的外链 scheme；file: 与自定义协议交给
// shell.openExternal 等同启动本地程序，一律拦截
const ALLOWED_EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:']

// 开发期开 CDP 调试端口，供自动化 E2E 验证驱动。
// 命令行已指定时不覆盖（9222 被占用时可用 electron-vite dev --remoteDebuggingPort <port>）
if (!app.isPackaged && !app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// 主进程构建为 CJS（apps/desktop 无 type:module，electron-vite 自动按
// CJS 产出）——Electron 43 的 ESM 入口对 electron 内置模块的具名/默认
// 导出解析不可靠，require('electron') 是稳定路径。__dirname 在 CJS 原生可用。
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#050a0f',
    title: 'Amadeus',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 窗口最小化/遮挡时 Chromium 会暂停 RAF 与定时器，Live2D 渲染循环
      // 随之冻结（语音通话中口型/表情也会停）。关闭节流保持动画常跑。
      backgroundThrottling: false
    }
  })

  // 桌面端媒体权限直接放行（麦克风/摄像头：语音通话与视觉输入必需）
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })

  win.on('ready-to-show', () => win.show())

  // 外部链接一律走系统浏览器，不在应用内开新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (ALLOWED_EXTERNAL_PROTOCOLS.includes(new URL(url).protocol)) {
        void shell.openExternal(url)
      }
    } catch {
      // 解析失败的 URL 不予打开
    }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
