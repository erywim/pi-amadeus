import { join } from 'node:path'
import { app, BrowserWindow, screen, session, shell, type WebContents } from 'electron'
import { PetPointer } from './pet-pointer'

export type AppMode = 'window' | 'pet'

const isMac = process.platform === 'darwin'

// 允许交给系统打开的外链 scheme；file: 与自定义协议交给
// shell.openExternal 等同启动本地程序，一律拦截
const ALLOWED_EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:']

// 桌宠渲染层的就绪超时：模型加载失败等情况下退回窗口模式，不留下看不见的全屏窗口
const PET_READY_TIMEOUT_MS = 15_000

// 主进程构建为 CJS（apps/desktop 无 type:module，electron-vite 自动按
// CJS 产出）——Electron 43 的 ESM 入口对 electron 内置模块的具名/默认
// 导出解析不可靠，require('electron') 是稳定路径。__dirname 在 CJS 原生可用。
const PRELOAD = join(__dirname, '../preload/index.js')

/** 外部链接一律走系统浏览器，不在应用内开新窗 */
function openExternalSafely({ url }: { url: string }): { action: 'deny' } {
  try {
    if (ALLOWED_EXTERNAL_PROTOCOLS.includes(new URL(url).protocol)) {
      void shell.openExternal(url)
    }
  } catch {
    // 解析失败的 URL 不予打开
  }
  return { action: 'deny' }
}

/** 加载渲染层：dev 走 Vite 服务，build 走打包产物；query 标明窗口角色（桌宠窗口 ?window=pet） */
function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const url = new URL(devUrl)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

interface WindowSnapshot {
  visible: boolean
  bounds: Electron.Rectangle
  alwaysOnTop: boolean
}

function snapshot(win: BrowserWindow | null): WindowSnapshot | null {
  if (!win || win.isDestroyed()) return null
  return { visible: win.isVisible(), bounds: win.getBounds(), alwaysOnTop: win.isAlwaysOnTop() }
}

/**
 * 窗口与模式（交互逻辑参考 XnneHangLab 的桌宠模式）：
 * - window：常规主窗口
 * - pet：独立的透明置顶窗口铺满当前显示器工作区，主窗口隐藏。
 *   桌宠窗口先隐藏加载，渲染层画出首帧（pet:ready）后才显示并隐藏主窗口，切换无闪烁；
 *   退出时销毁桌宠窗口、恢复主窗口。
 */
export class WindowManager {
  private main: BrowserWindow | null = null
  private pet: BrowserWindow | null = null
  private petShown = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private petPointer: PetPointer | null = null
  private mode: AppMode = 'window'
  private quitting = false
  private readonly listeners = new Set<() => void>()

  constructor() {
    app.on('before-quit', () => {
      this.quitting = true
    })
  }

  getMode(): AppMode {
    return this.mode
  }

  /** 模式或强制穿透变化时回调（托盘据此刷新） */
  onStateChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** 强制穿透：桌宠整窗不接收鼠标（每次进入桌宠时为关） */
  isPassthroughForced(): boolean {
    return this.petPointer?.isForced() ?? false
  }

  setPassthroughForced(forced: boolean): void {
    if (!this.petPointer) return
    this.petPointer.setForced(forced)
    this.notify()
  }

  /** 渲染层命中检测结果：只认桌宠窗口自己的 webContents */
  setPetInteractive(sender: WebContents, interactive: boolean): void {
    if (sender !== this.pet?.webContents) return
    this.petPointer?.setInteractive(interactive)
  }

  /** 开发期 e2e：用指定屏幕坐标代替真实光标 */
  debugSetPetCursor(point: Electron.Point | null): void {
    this.petPointer?.debugOverride(point)
  }

  createMainWindow(): BrowserWindow {
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
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 窗口最小化/遮挡时 Chromium 会暂停 RAF 与定时器，Live2D 渲染循环
        // 随之冻结（语音通话中口型/表情也会停）。关闭节流保持动画常跑。
        backgroundThrottling: false
      }
    })

    // 桌面端媒体权限直接放行（麦克风/摄像头：语音通话与视觉输入必需；桌宠窗口同 session 共用）
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'display-capture')
    })

    win.on('ready-to-show', () => win.show())
    win.webContents.setWindowOpenHandler(openExternalSafely)
    win.on('closed', () => {
      if (this.main === win) this.main = null
    })
    loadRenderer(win)
    this.main = win
    return win
  }

  setMode(mode: AppMode): void {
    if (mode === this.mode) return
    if (mode === 'pet') this.enterPetMode()
    else this.exitPetMode()
  }

  /** 托盘「显示」：当前模式的窗口 */
  showCurrent(): void {
    if (this.mode === 'window') this.showMain()
    else if (this.petShown) {
      this.pet?.showInactive()
      this.petPointer?.start()
    }
  }

  /** 托盘「隐藏」：当前模式的窗口 */
  hideCurrent(): void {
    if (this.mode === 'window') {
      this.main?.hide()
      return
    }
    this.petPointer?.stop()
    this.pet?.hide()
  }

  /** 桌宠渲染层首帧已画：显示桌宠窗口，隐藏主窗口 */
  handlePetReady(sender: WebContents): void {
    const pet = this.pet
    if (!pet || sender !== pet.webContents || this.petShown) return
    this.clearReadyTimer()
    this.petShown = true
    this.hideMainForPet()
    // macOS：所有桌面空间可见、浮在全屏应用之上。副作用：桌宠期间 Dock 图标隐藏（入口在托盘）
    if (isMac) pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    pet.showInactive()
    this.petPointer?.start()
  }

  /** 开发期 e2e 用：窗口状态快照 */
  debugState(): {
    mode: AppMode
    petShown: boolean
    /** 桌宠窗口当前是否在接收鼠标（未穿透） */
    petCapturing: boolean
    petPassthroughForced: boolean
    main: WindowSnapshot | null
    pet: WindowSnapshot | null
    petWorkArea: Electron.Rectangle | null
  } {
    const pet = this.pet && !this.pet.isDestroyed() ? this.pet : null
    return {
      mode: this.mode,
      petShown: this.petShown,
      petCapturing: this.petPointer?.isCapturing() ?? false,
      petPassthroughForced: this.isPassthroughForced(),
      main: snapshot(this.main),
      pet: snapshot(pet),
      petWorkArea: pet ? screen.getDisplayMatching(pet.getBounds()).workArea : null
    }
  }

  private enterPetMode(): void {
    this.mode = 'pet'
    this.pet = this.createPetWindow()
    this.petPointer = new PetPointer(this.pet)
    this.emit()
  }

  private exitPetMode(): void {
    this.mode = 'window'
    this.clearReadyTimer()
    const pet = this.pet
    this.pet = null
    this.petShown = false
    this.petPointer?.stop()
    this.petPointer = null
    pet?.destroy()
    // 先恢复桌宠期间隐藏的 Dock 图标，主窗口才能正常获得焦点
    if (isMac && app.dock) void app.dock.show().then(() => this.showMain())
    else this.showMain()
    this.emit()
  }

  private createPetWindow(): BrowserWindow {
    // 铺满主窗口所在显示器的工作区（macOS 各显示器各自一个 Space，单窗口无法跨屏）
    const anchor = this.main?.isVisible() ? this.main.getBounds() : null
    const display = anchor
      ? screen.getDisplayMatching(anchor)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const pet = new BrowserWindow({
      ...display.workArea,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // macOS：非激活窗口上的第一下点击也送达页面（默认首击只用于激活窗口）
      acceptFirstMouse: true,
      title: 'Amadeus',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    // 与 XnneHangLab 一致的置顶层级：盖过普通窗口、Dock 与全屏应用
    pet.setAlwaysOnTop(true, 'screen-saver')
    // 整窗鼠标穿透：桌面照常可点
    pet.setIgnoreMouseEvents(true, { forward: true })
    pet.webContents.setWindowOpenHandler(openExternalSafely)
    pet.on('closed', () => {
      if (this.pet !== pet) return
      // 不经 setMode 的关闭（如 Windows 上 Alt+F4）：回到窗口模式，不把用户留在没有窗口的状态
      this.pet = null
      if (!this.quitting) this.setMode('window')
    })
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null
      if (this.pet === pet && !this.petShown) this.setMode('window')
    }, PET_READY_TIMEOUT_MS)
    loadRenderer(pet, { window: 'pet' })
    return pet
  }

  private hideMainForPet(): void {
    const main = this.main
    if (!main) return
    main.hide()
    // 隐藏期间恢复后台节流：主窗口的 Live2D 渲染循环随之暂停，不与桌宠窗口抢 GPU
    main.webContents.setBackgroundThrottling(true)
  }

  private showMain(): void {
    const main = this.main
    if (!main) {
      this.createMainWindow()
      return
    }
    main.webContents.setBackgroundThrottling(false)
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  }

  private emit(): void {
    for (const win of [this.main, this.pet]) {
      if (win && !win.isDestroyed()) win.webContents.send('mode:changed', this.mode)
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }
}
