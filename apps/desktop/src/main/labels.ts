/**
 * 主进程原生菜单（托盘 / 桌宠右键菜单）的文案。
 * 语言跟随渲染层 i18n：渲染层切换语言时经 app:ui-language 上报。
 */
const LABELS = {
  zh: {
    windowMode: '窗口模式',
    petMode: '桌宠模式',
    passthrough: '鼠标穿透',
    show: '显示',
    hide: '隐藏',
    quit: '退出'
  },
  en: {
    windowMode: 'Window Mode',
    petMode: 'Desktop Pet Mode',
    passthrough: 'Mouse Passthrough',
    show: 'Show',
    hide: 'Hide',
    quit: 'Quit'
  },
  ja: {
    windowMode: 'ウィンドウモード',
    petMode: 'デスクトップマスコット',
    passthrough: 'マウス透過',
    show: '表示',
    hide: '非表示',
    quit: '終了'
  }
} as const

type Lang = keyof typeof LABELS
export type MenuLabels = (typeof LABELS)[Lang]

let current: Lang = 'zh'

/** 设置菜单语言（取语言代码主段，如 en-US → en）；返回是否发生变化 */
export function setMenuLanguage(lang: string): boolean {
  const base = lang.split('-')[0]
  if (base !== 'zh' && base !== 'en' && base !== 'ja') return false
  if (base === current) return false
  current = base
  return true
}

export function menuLabels(): MenuLabels {
  return LABELS[current]
}
