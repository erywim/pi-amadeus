import { app, ipcMain, shell } from 'electron'
import {
  parseProactiveConfigPatch,
  requestScreenPermission,
  screenPermission,
  type ProactiveWatcher
} from './proactive'
import { ComputerControl } from './computer-control'
import type { WindowManager } from './window-manager'

/**
 * IPC 面：应用元信息 + 打开目录（skill 管理页）+ 窗口/桌宠模式 + 主动问候配置。
 * 其余大脑服务以 HTTP/SSE 直连渲染层。渲染层传入的参数一律按 unknown 校验。
 */
export function registerIpcHandlers(
  windows: WindowManager,
  proactive: ProactiveWatcher,
  onUiLanguage: (lang: string) => void,
  computer: ComputerControl
): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('computer:execute', (event, action: unknown) => computer.execute(event.sender, action))
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
  ipcMain.on('pet:menu', (event) => windows.showPetContextMenu(event.sender))
  ipcMain.on('pet:set-interactive', (event, interactive: unknown) => {
    if (typeof interactive === 'boolean') windows.setPetInteractive(event.sender, interactive)
  })
  ipcMain.on('pet:set-escape', (event, escape: unknown) => {
    if (typeof escape === 'boolean') windows.setPetEscape(event.sender, escape)
  })
  ipcMain.on('pet:set-passthrough', (event, forced: unknown) => {
    if (typeof forced === 'boolean') windows.setPetPassthrough(event.sender, forced)
  })

  // 主动问候：渲染层是配置的唯一来源（开关在设置页，身份/会话/忙碌来自 store）。
  // 两个窗口都会上报，字段逐个校验后再合并
  ipcMain.on('proactive:config', (_event, payload: unknown) => {
    const patch = parseProactiveConfigPatch(payload)
    if (patch) proactive.setConfig(patch)
  })
  // 设置页展示屏幕录制权限状态（macOS 未授权时提示用户去系统设置开）
  ipcMain.handle('proactive:permission', () => screenPermission())
  // 用户打开开关时主动触发一次系统授权（后台定时器不会自己撞系统弹窗）
  ipcMain.handle('proactive:request-permission', () => requestScreenPermission())
}
