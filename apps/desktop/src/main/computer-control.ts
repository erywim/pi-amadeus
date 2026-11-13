import { BrowserWindow, nativeImage, type WebContents } from 'electron'
import type { ComputerAction, ComputerExecutionResult, ComputerScreenshot } from '@pi-amadeus/shared'

const MAX_TEXT = 2000
const MAX_COORDINATE = 10_000
const MAX_SCREENSHOT_BYTES = 8_000_000
const ACTIONS = new Set<ComputerAction['action']>([
  'click',
  'double_click',
  'drag',
  'keypress',
  'move',
  'screenshot',
  'scroll',
  'type',
  'wait'
])

const ALLOWED_KEYS = new Set([
  'BACKSPACE',
  'TAB',
  'ENTER',
  'ESC',
  'SPACE',
  'ARROWLEFT',
  'ARROWRIGHT',
  'ARROWUP',
  'ARROWDOWN',
  'HOME',
  'END',
  'PAGEUP',
  'PAGEDOWN',
  'DELETE',
  'SHIFT',
  'CTRL',
  'ALT',
  'CMD',
  'META'
])

/**
 * 受限的桌面动作执行器：当前只控制受信任 Electron 窗口。
 * 截图和输入都走 Electron 原生窗口 API，不通过 bash/脚本回退，避免把模型动作
 * 重新变成任意命令执行；这不是全系统桌面控制器。
 */
export class ComputerControl {
  private readonly windows = new Set<WebContents>()

  registerWindow(win: BrowserWindow): void {
    this.windows.add(win.webContents)
    win.webContents.once('destroyed', () => this.windows.delete(win.webContents))
  }

  async execute(sender: WebContents, action: ComputerAction): Promise<ComputerExecutionResult> {
    if (!this.windows.has(sender)) return failure('permission_denied', '未知窗口不能执行 computer 动作')
    const win = BrowserWindow.fromWebContents(sender)
    if (!win || win.isDestroyed()) return failure('execution_failed', '目标窗口已关闭')
    try {
      validateAction(action)
      if (action.action !== 'screenshot') {
        await runWindowAction(action, win)
      }
      return await captureWindow(win)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(message.includes('权限') ? 'permission_denied' : 'execution_failed', message)
    }
  }
}

function validateAction(action: ComputerAction): void {
  if (!action || typeof action.action !== 'string' || !ACTIONS.has(action.action)) throw new Error('动作缺少或不支持 action')
  for (const value of [action.x, action.y]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > MAX_COORDINATE)) throw new Error('坐标超出范围')
  }
  if (action.text !== undefined && (typeof action.text !== 'string' || action.text.length > MAX_TEXT)) throw new Error('输入文本过长')
  if (action.keys && (!Array.isArray(action.keys) || action.keys.length > 4 || action.keys.some((key) => typeof key !== 'string' || (!ALLOWED_KEYS.has(key.toUpperCase()) && !/^[a-z0-9]$/i.test(key))))) {
    throw new Error('按键不在允许列表')
  }
  if (action.path && (action.path.length < 2 || action.path.length > 64 || action.path.some((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y)))) {
    throw new Error('拖拽路径无效')
  }
  if (action.action === 'type' && action.text === undefined) throw new Error('type 缺少 text')
  if (action.action === 'keypress' && (!action.keys || action.keys.length === 0)) throw new Error('keypress 缺少 keys')
  if (action.action === 'drag' && !action.path) throw new Error('drag 缺少 path')
  if (['click', 'double_click', 'move', 'scroll'].includes(action.action) && (action.x === undefined || action.y === undefined)) throw new Error(`${action.action} 缺少 x/y`)
}

async function captureWindow(win: BrowserWindow): Promise<ComputerExecutionResult> {
  const image = await win.webContents.capturePage()
  const png = image.toPNG()
  if (png.byteLength > MAX_SCREENSHOT_BYTES) return failure('execution_failed', '截图超过大小限制')
  const jpeg = image.toJPEG(70)
  const data = (jpeg.byteLength <= MAX_SCREENSHOT_BYTES ? jpeg : png).toString('base64')
  const mimeType = jpeg.byteLength <= MAX_SCREENSHOT_BYTES ? 'image/jpeg' : 'image/png'
  const size = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize()
  const screenshot: ComputerScreenshot = { data, mimeType, width: size.width, height: size.height, surface: 'window' }
  return { ok: true, screenshot }
}

async function runWindowAction(action: ComputerAction, win: BrowserWindow): Promise<void> {
  win.focus()
  const toWindow = (x: number, y: number): { x: number; y: number } => ({ x, y })
  if (action.action === 'wait') {
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    return
  }
  if (action.action === 'type') {
    await win.webContents.insertText(action.text ?? '')
    return
  }
  if (action.action === 'keypress') {
    const keys = action.keys ?? []
    if (keys.length !== 1) throw new Error('当前窗口模式只支持单个按键')
    const key = keys[0]!
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: [] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: [] })
    return
  }
  if (action.action === 'scroll') {
    const point = toWindow(action.x ?? 0, action.y ?? 0)
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: action.scroll_x ?? 0,
      deltaY: action.scroll_y ?? 0
    })
    return
  }
  if (action.action === 'drag') {
    const path = action.path ?? []
    const first = path[0]!
    win.webContents.sendInputEvent({ type: 'mouseMove', x: first.x, y: first.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: first.x, y: first.y, button: action.button ?? 'left' })
    for (const point of path.slice(1)) win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    const last = path[path.length - 1]!
    win.webContents.sendInputEvent({ type: 'mouseUp', x: last.x, y: last.y, button: action.button ?? 'left' })
    return
  }
  const point = toWindow(action.x ?? 0, action.y ?? 0)
  if (action.action === 'move') {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  } else {
    const button = action.button ?? 'left'
    const clickCount = action.action === 'double_click' ? 2 : 1
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button, clickCount })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button, clickCount })
  }
}

function failure(code: NonNullable<ComputerExecutionResult['error']>['code'], message: string): ComputerExecutionResult {
  return { ok: false, error: { code, message } }
}
