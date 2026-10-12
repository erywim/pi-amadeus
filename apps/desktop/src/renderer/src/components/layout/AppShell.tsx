import * as React from 'react'
import { useEffect, useRef } from 'react'
import { Settings, Terminal, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { cn } from '@renderer/lib/utils'
import { setTtsMuted } from '@renderer/lib/ttsPlayer'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore } from '@renderer/stores/uiStore'

const TAB_ROUTES = ['/companion', '/text'] as const

/**
 * 应用外壳（OpenDesign 原型结构）：56px 顶栏 = 品牌区 + 模式页签
 * （陪伴 / 文本，role=tablist）+ 设置齿轮 + 当前模型胶囊；下方为各视图。
 * 陪伴视图挂载时 body.theme-amadeus 整套令牌翻转为暗色实验台。
 */
export default function AppShell(): React.JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useSettingsStore((s) => s.theme)
  const aiModel = useSettingsStore((s) => s.aiConfig.provider.model)
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

  // 顶栏模型胶囊需要配置：登录身份就绪且未加载时拉一次
  useEffect(() => {
    if (userId && !configLoaded) {
      loadAiConfig(userId).catch((error: unknown) => {
        console.warn('[config] 加载失败：', error)
      })
    }
  }, [userId, configLoaded, loadAiConfig])

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
    { path: '/text', icon: Terminal, label: t('nav.text') }
  ]

  return (
    <div className="grid h-screen grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-5">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-[9px] bg-primary text-primary-foreground">
            <span className="font-serif text-[16px] font-bold italic leading-none">A</span>
          </span>
          <span className="text-[16px] font-semibold tracking-[0.02em]">{t('app.title')}</span>
          <span className="ml-1 hidden text-[12.5px] text-muted-foreground md:inline">
            {t('app.brandTag')}
          </span>
        </div>

        <nav role="tablist" aria-label={t('nav.modeSwitch')} className="mx-auto flex gap-0.5 rounded-xl border border-border bg-surface-soft p-[3px]">
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
            className="hidden max-w-60 items-center gap-2 rounded-full border border-border px-3 py-1 text-[12.5px] text-muted-foreground lg:flex"
          >
            <span className={cn('size-1.5 shrink-0 rounded-full', aiModel ? 'bg-mint' : 'bg-line-strong')} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {aiModel || t('topbar.modelUnset')}
            </span>
          </span>
        </div>
      </header>

      <main className="grid min-h-0">
        <div key={location.pathname} className="anim-view grid min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
