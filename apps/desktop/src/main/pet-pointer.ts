import { screen, type BrowserWindow } from 'electron'

// 光标轮询间隔：约 60Hz；坐标不变时不推送
const POLL_MS = 16

/**
 * 桌宠窗口的鼠标穿透（参考 XnneHangLab）：默认整窗穿透，桌面照常可点。
 * 主进程轮询全局光标、换算成窗口内坐标推给渲染层（pet:cursor）；渲染层对角色网格 /
 * 对话框做命中检测，命中时请求可交互（pet:set-interactive），离开时恢复穿透。
 * 不依赖穿透期间 forward 转发的 mousemove（macOS 上不可靠），两平台同一路径。
 * 强制穿透（托盘「鼠标穿透」）打开时一律穿透，不理会命中。
 */
export class PetPointer {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastX = Number.NaN
  private lastY = Number.NaN
  private interactive = false
  private forced = false
  /** 开发期 e2e：用指定的屏幕坐标代替真实光标 */
  private override: Electron.Point | null = null

  constructor(private readonly win: BrowserWindow) {}

  start(): void {
    if (this.timer) return
    this.lastX = Number.NaN
    this.timer = setInterval(this.poll, POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setInteractive(interactive: boolean): void {
    this.interactive = interactive
    this.apply()
  }

  isForced(): boolean {
    return this.forced
  }

  setForced(forced: boolean): void {
    this.forced = forced
    this.apply()
    this.win.webContents.send('pet:passthrough', forced)
  }

  /** 实际是否在接收鼠标（未穿透） */
  isCapturing(): boolean {
    return this.interactive && !this.forced
  }

  debugOverride(point: Electron.Point | null): void {
    this.override = point
  }

  private apply(): void {
    if (this.win.isDestroyed()) return
    this.win.setIgnoreMouseEvents(!this.isCapturing(), { forward: true })
  }

  private readonly poll = (): void => {
    if (this.win.isDestroyed()) {
      this.stop()
      return
    }
    const point = this.override ?? screen.getCursorScreenPoint()
    if (point.x === this.lastX && point.y === this.lastY) return
    this.lastX = point.x
    this.lastY = point.y
    const bounds = this.win.getBounds()
    this.win.webContents.send('pet:cursor', { x: point.x - bounds.x, y: point.y - bounds.y })
  }
}
