import * as React from 'react'
import { useEffect, useRef } from 'react'
import {
  ArrowLeftRight,
  BarChart3,
  Blocks,
  BookOpen,
  Brain,
  CalendarClock,
  Bot,
  Settings,
  Terminal,
  UserRound
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { BranchTreeDialog } from '@renderer/features/chat/BranchTreeDialog'
import { CommandPalette } from '@renderer/features/command-palette/CommandPalette'
import { ShortcutsDialog } from '@renderer/features/shortcuts/ShortcutsDialog'
import { cn } from '@renderer/lib/utils'
import { setTtsMuted } from '@renderer/lib/ttsPlayer'
import { useMemoryStore } from '@renderer/stores/memoryStore'
import { usePluginStore } from '@renderer/stores/pluginStore'
import { activeProviderOf, useProviderStore } from '@renderer/stores/providerStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore } from '@renderer/stores/uiStore'

const TAB_ROUTES = [
  '/companion',
  '/text',
  '/memory',
  '/knowledge',
  '/automations',
  '/plugins',
  '/dashboard',
  '/conversion',
  '/agents'
] as const

/**
 * 应用外壳（早期界面原型结构）：56px 顶栏 = 品牌区 + 模式页签
 * （陪伴 / 文本，role=tablist）+ 设置齿轮 + 当前模型胶囊；下方为各视图。
 * 陪伴视图挂载时 body.theme-amadeus 整套令牌翻转为暗色实验台。
 */
export default function AppShell(): React.JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useSettingsStore((s) => s.theme)
  const aiModel = useSettingsStore((s) => s.aiConfig.provider.model)
  const providers = useProviderStore((s) => s.providers)
  const activeProvider = activeProviderOf(providers)
  // 激活的模型服务优先于内置配置：顶栏胶囊要显示真正在用的模型
  const modelLabel = activeProvider?.model || aiModel
  const configLoaded = useSettingsStore((s) => s.configLoaded)
  const loadAiConfig = useSettingsStore((s) => s.loadAiConfig)
  const userId = useSessionStore((s) => s.userId)
  const ttsMuted = useUiStore((s) => s.ttsMuted)
  const setUiMuted = useUiStore((s) => s.setTtsMuted)

  const isCompanion = location.pathname === '/companion'
  const isSettings = location.pathname === '/settings'
  /** 设置页从哪个模式进入的，齿轮再点返回 */
  const lastTabRoute = useRef<string>('/companion')

  // 主题：陪伴视图级联 body.theme-amadeus（优先级盖过 dark）
  useEffect(() => {
    document.body.classList.toggle('theme-amadeus', isCompanion)
    document.body.classList.toggle('dark', theme === 'cyber')
  }, [isCompanion, theme])

  // 语音播报静音：设置项 defaultMute 只在启动时落一次；运行期以 uiStore 为准并同步到播放器
  useEffect(() => {
    setUiMuted(useSettingsStore.getState().defaultMute)
    // 只在启动时执行一次；defaultMute 故意不进依赖
  }, [])
  useEffect(() => {
    setTtsMuted(ttsMuted)
  }, [ttsMuted])

  // 全局快捷键：⌘/Ctrl+K 命令面板；⌘/Ctrl+/ 快捷键速查
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) return
      const ui = useUiStore.getState()
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        ui.setCommandPaletteOpen(!ui.commandPaletteOpen)
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        ui.setShortcutsOpen(!ui.shortcutsOpen)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 顶栏模型胶囊需要配置：登录身份就绪且未加载时拉一次
  useEffect(() => {
    if (userId && !configLoaded) {
      loadAiConfig(userId).catch((error: unknown) => {
        console.warn('[config] 加载失败：', error)
      })
    }
  }, [userId, configLoaded, loadAiConfig])

  // 插件列表全局加载一次：快捷指令（输入框）、已安装主题（启动恢复）都依赖它
  useEffect(() => {
    void usePluginStore.getState().load()
    void useProviderStore.getState().load()
  }, [])

  // 记忆与好感度：登录身份就绪后加载一次，侧栏与记忆页共用
  useEffect(() => {
    if (userId) void useMemoryStore.getState().load(userId)
  }, [userId])

  useEffect(() => {
    if (TAB_ROUTES.includes(location.pathname as (typeof TAB_ROUTES)[number])) {
      lastTabRoute.current = location.pathname
    }
  }, [location.pathname])

  function toggleSettings(): void {
    navigate(isSettings ? lastTabRoute.current : '/settings')
  }

  const tabs = [
    { path: '/companion', icon: UserRound, label: t('nav.companion') },
    { path: '/text', icon: Terminal, label: t('nav.text') },
    { path: '/memory', icon: Brain, label: t('nav.memory') },
    { path: '/knowledge', icon: BookOpen, label: t('nav.knowledge') },
    { path: '/automations', icon: CalendarClock, label: t('nav.automations') },
    { path: '/plugins', icon: Blocks, label: t('nav.plugins') },
    { path: '/dashboard', icon: BarChart3, label: t('nav.dashboard') },
    { path: '/conversion', icon: ArrowLeftRight, label: t('nav.conversion') },
    { path: '/agents', icon: Bot, label: t('nav.agents') }
  ]

  return (
    <div className="grid h-screen grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex h-14 min-w-0 items-center gap-3 border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-[9px] bg-primary text-primary-foreground">
            <span className="font-serif text-[16px] font-bold italic leading-none">A</span>
          </span>
          <span className="text-[16px] font-semibold tracking-[0.02em]">{t('app.title')}</span>
          <span className="ml-1 hidden text-[12.5px] text-muted-foreground md:inline">
            {t('app.brandTag')}
          </span>
        </div>

        <nav role="tablist" aria-label={t('nav.modeSwitch')} className="mx-auto flex min-w-0 gap-0.5 overflow-x-auto rounded-xl border border-border bg-surface-soft p-[3px]">
          {tabs.map(({ path, icon: Icon, label }) => {
            const selected = location.pathname === path
            return (
              <button
                key={path}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => navigate(path)}
                className={cn(
                  'flex items-center gap-2 whitespace-nowrap rounded-[9px] px-3.5 py-1.5 text-[15px] text-muted-foreground transition-colors hover:text-ink-2',
                  selected &&
                    'bg-surface font-semibold text-foreground shadow-[0_1px_3px_rgba(26,29,33,0.10)]'
                )}
              >
                <Icon className="size-[15px]" strokeWidth={1.8} />
                {label}
              </button>
            )
          })}
        </nav>

        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={t('nav.settings')}
            aria-pressed={isSettings}
            title={t('nav.settings')}
            onClick={toggleSettings}
            className={cn(
              'grid size-9.5 place-items-center rounded-[10px] border border-border bg-surface text-ink-2 transition-colors hover:bg-surface-soft',
              isSettings && 'bg-surface-soft text-foreground'
            )}
          >
            <Settings className="size-4" strokeWidth={1.6} />
          </button>
          <span
            title={t('topbar.modelChip')}
            className="hidden max-w-40 items-center gap-2 rounded-full border border-border px-3 py-1 text-[12.5px] text-muted-foreground xl:flex"
          >
            <span className={cn('size-1.5 shrink-0 rounded-full', modelLabel ? 'bg-mint' : 'bg-line-strong')} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {modelLabel || t('topbar.modelUnset')}
            </span>
          </span>
        </div>
      </header>

      <main className="grid min-h-0">
        <div key={location.pathname} className="anim-view grid min-h-0">
          <Outlet />
        </div>
      </main>

      <CommandPalette />
      <BranchTreeDialog />
      <ShortcutsDialog />
    </div>
  )
}
