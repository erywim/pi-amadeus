import type { MenuItemConstructorOptions } from 'electron'
import { menuLabels } from './labels'
import type { WindowManager } from './window-manager'

/**
 * 模式切换与鼠标穿透的菜单项：托盘与桌宠右键菜单共用。
 * 桌宠窗口没有可见的窗口边框，右键菜单是它自己的出口（窗口模式 / 穿透）。
 */
export function buildModeMenuItems(windows: WindowManager): MenuItemConstructorOptions[] {
  const labels = menuLabels()
  const mode = windows.getMode()
  return [
    { label: labels.windowMode, type: 'radio', checked: mode === 'window', click: () => windows.setMode('window') },
    { label: labels.petMode, type: 'radio', checked: mode === 'pet', click: () => windows.setMode('pet') },
    { type: 'separator' },
    // 强制穿透后角色点不到、右键菜单也出不来，只能从托盘关回来
    ...(mode === 'pet'
      ? ([
          {
            label: labels.passthrough,
            type: 'checkbox',
            checked: windows.isPassthroughForced(),
            click: () => windows.setPassthroughForced(!windows.isPassthroughForced())
          },
          { type: 'separator' }
        ] satisfies MenuItemConstructorOptions[])
      : [])
  ]
}
