import { app, ipcMain, shell } from 'electron'
import type { WindowManager } from './window-manager'

/**
 * IPC 面：应用元信息 + 打开目录（skill 管理页）+ 窗口/桌宠模式。
 * 其余大脑服务以 HTTP/SSE 直连渲染层。渲染层传入的参数一律按 unknown 校验。
 */
export function registerIpcHandlers(windows: WindowManager, onUiLanguage: (lang: string) => void): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:platform', () => process.platform)
  // 返回空串=成功；非空=错误消息（shell.openPath 契约）
  ipcMain.handle('shell:openPath', (_event, path: unknown) =>
    shell.openPath(typeof path === 'string' ? path : '')
  )
  // 渲染层 i18n 语言变化 → 原生菜单文案跟随
  ipcMain.on('app:ui-language', (_event, lang: unknown) => {
    if (typeof lang === 'string') onUiLanguage(lang)
  })

  ipcMain.handle('mode:get', () => windows.getMode())
  ipcMain.on('mode:set', (_event, mode: unknown) => {
    if (mode === 'window' || mode === 'pet') windows.setMode(mode)
  })
  ipcMain.on('pet:ready', (event) => windows.handlePetReady(event.sender))
  ipcMain.on('pet:set-interactive', (event, interactive: unknown) => {
    if (typeof interactive === 'boolean') windows.setPetInteractive(event.sender, interactive)
  })
}
