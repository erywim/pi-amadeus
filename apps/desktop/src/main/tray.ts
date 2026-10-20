import { readFileSync } from 'node:fs'
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import trayColor from '../../resources/tray.png?asset'
import trayColor2x from '../../resources/tray@2x.png?asset'
import trayTemplate from '../../resources/trayTemplate.png?asset'
import trayTemplate2x from '../../resources/trayTemplate@2x.png?asset'
import { menuLabels } from './labels'
import { buildModeMenuItems } from './menus'
import type { WindowManager } from './window-manager'

const isMac = process.platform === 'darwin'

/** 托盘：窗口模式 / 桌宠模式切换 +（桌宠时）鼠标穿透 + 显示 / 隐藏 / 退出（桌宠期间 macOS 无 Dock 图标，入口在这里） */
export class AppTray {
  private tray: Tray | null = null
  private items: MenuItemConstructorOptions[] = []

  constructor(private readonly windows: WindowManager) {}

  create(): void {
    // macOS 用模板图（系统按菜单栏明暗自动着色）；其它平台用彩色图标。
    // ?asset 产物文件名带哈希，@2x 不会被 nativeImage 自动配对，手动加 2x 表示
    const image = nativeImage.createFromPath(isMac ? trayTemplate : trayColor)
    image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(isMac ? trayTemplate2x : trayColor2x) })
    if (isMac) image.setTemplateImage(true)
    this.tray = new Tray(image)
    this.tray.setToolTip('Amadeus')
    this.refresh()
  }

  refresh(): void {
    if (!this.tray) return
    const labels = menuLabels()
    this.items = [
      ...buildModeMenuItems(this.windows),
      { label: labels.show, click: () => this.windows.showCurrent() },
      { label: labels.hide, click: () => this.windows.hideCurrent() },
      { type: 'separator' },
      { label: labels.quit, click: () => app.quit() }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(this.items))
  }

  /** 开发期 e2e 用：当前菜单项（标签 + 勾选态） */
  debugItems(): Array<{ label: string; checked?: boolean }> {
    return this.items
      .filter((item) => item.type !== 'separator')
      .map((item) => ({ label: String(item.label), checked: item.checked }))
  }
}
