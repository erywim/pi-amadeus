import { create } from 'zustand'
import type { CatalogEntry, InstalledPlugin } from '@pi-amadeus/shared'
import {
  addCustomMcpApi,
  fetchPlugins,
  installPluginApi,
  reconnectPluginApi,
  setPluginEnabledApi,
  uninstallPluginApi
} from '@renderer/lib/api'

const THEME_STORAGE_KEY = 'amadeus_plugin_theme'
/** 当前由插件写在 body 上的变量名：换主题时先逐个移除，避免上一套残留 */
let appliedVars: string[] = []

/** 已安装的快捷指令（prompt 插件）：输入框的指令菜单用 */
export interface PromptCommand {
  id: string
  name: string
  description: string
  prompt: string
  icon: string
}

interface PluginState {
  installed: InstalledPlugin[]
  catalog: CatalogEntry[]
  skillsDir: string
  loaded: boolean
  /** 首次加载进行中（AppShell 与插件页可能同时触发，去重） */
  loading: boolean
  /** 正在执行安装/卸载/启停的插件 id（按钮 loading 用） */
  busyId: string | null
  /** 当前生效的主题插件 id；null = 默认主题 */
  activeThemeId: string | null

  load: () => Promise<void>
  install: (id: string, fields?: Record<string, string>) => Promise<void>
  uninstall: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  reconnect: (id: string) => Promise<void>
  addCustomMcp: (input: {
    name: string
    command: string
    args: string[]
    env: Record<string, string>
  }) => Promise<void>
  applyTheme: (id: string | null) => void
}

function setThemeVars(vars: Record<string, string> | null): void {
  for (const name of appliedVars) document.body.style.removeProperty(name)
  appliedVars = []
  if (!vars) return
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith('--')) continue
    document.body.style.setProperty(name, value)
    appliedVars.push(name)
  }
}

export const usePluginStore = create<PluginState>()((set, get) => ({
  installed: [],
  catalog: [],
  skillsDir: '',
  loaded: false,
  loading: false,
  busyId: null,
  activeThemeId: null,

  load: async () => {
    if (get().loaded || get().loading) return
    set({ loading: true })
    try {
      const data = await fetchPlugins()
      set({ installed: data.installed, catalog: data.catalog, skillsDir: data.skillsDir, loaded: true })
      // 启动时恢复上次选中的主题；插件已被卸载/停用时回落到默认主题
      const saved = localStorage.getItem(THEME_STORAGE_KEY)
      if (saved) {
        const theme = data.installed.find((p) => p.id === saved && p.kind === 'theme' && p.enabled)
        if (theme) get().applyTheme(saved)
        else {
          localStorage.removeItem(THEME_STORAGE_KEY)
          setThemeVars(null)
          set({ activeThemeId: null })
        }
      }
    } catch (error) {
      console.warn('[plugins] 加载失败：', error)
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  install: async (id, fields) => {
    set({ busyId: id })
    try {
      const plugin = await installPluginApi(id, fields)
      set((s) => ({
        installed: [...s.installed.filter((p) => p.id !== plugin.id), plugin]
      }))
    } finally {
      set({ busyId: null })
    }
  },

  uninstall: async (id) => {
    set({ busyId: id })
    try {
      await uninstallPluginApi(id)
      set((s) => ({ installed: s.installed.filter((p) => p.id !== id) }))
      // 卸载的是当前主题：立刻退回默认，别让界面停在已删除的配色上
      if (get().activeThemeId === id) get().applyTheme(null)
    } finally {
      set({ busyId: null })
    }
  },

  setEnabled: async (id, enabled) => {
    set({ busyId: id })
    try {
      const plugin = await setPluginEnabledApi(id, enabled)
      set((s) => ({
        installed: s.installed.map((p) => (p.id === id ? plugin : p))
      }))
      if (!enabled && get().activeThemeId === id) get().applyTheme(null)
    } finally {
      set({ busyId: null })
    }
  },

  reconnect: async (id) => {
    set({ busyId: id })
    try {
      const plugin = await reconnectPluginApi(id)
      set((s) => ({ installed: s.installed.map((p) => (p.id === id ? plugin : p)) }))
    } finally {
      set({ busyId: null })
    }
  },

  addCustomMcp: async (input) => {
    const plugin = await addCustomMcpApi(input)
    set((s) => ({ installed: [...s.installed.filter((p) => p.id !== plugin.id), plugin] }))
  },

  applyTheme: (id) => {
    if (!id) {
      setThemeVars(null)
      localStorage.removeItem(THEME_STORAGE_KEY)
      set({ activeThemeId: null })
      return
    }
    const plugin = get().installed.find((p) => p.id === id && p.kind === 'theme')
    const vars = plugin?.config.vars
    if (!plugin || !vars || typeof vars !== 'object' || Array.isArray(vars)) return
    const cleaned: Record<string, string> = {}
    for (const [name, value] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof value === 'string') cleaned[name] = value
    }
    setThemeVars(cleaned)
    localStorage.setItem(THEME_STORAGE_KEY, id)
    set({ activeThemeId: id })
  }
}))

/** 已启用的快捷指令：安装记录 × 目录元数据（图标/描述） */
export function promptCommandsOf(
  installed: InstalledPlugin[],
  catalog: CatalogEntry[]
): PromptCommand[] {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]))
  return installed
    .filter((plugin) => plugin.kind === 'prompt' && plugin.enabled)
    .map((plugin) => {
      const entry = byId.get(plugin.id)
      const prompt = typeof plugin.config.prompt === 'string' ? plugin.config.prompt : ''
      return {
        id: plugin.id,
        name: entry?.name ?? plugin.name,
        description: entry?.description ?? '',
        prompt,
        icon: entry?.icon ?? '⌘'
      }
    })
    .filter((command) => command.prompt.length > 0)
}
