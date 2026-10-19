import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { RouterProvider } from 'react-router/dom'
import { TooltipProvider } from './components/ui/tooltip'
import { PetRoot } from './features/pet/PetRoot'
import { bindMainWindowToAppMode } from './lib/appMode'
import { router } from './router'
import { useCompanionStore } from './stores/companionStore'
import { useLive2dStore } from './stores/live2dStore'
import { useLive2dSpeechStore } from './stores/live2dSpeechStore'
import { useSessionStore } from './stores/sessionStore'
import { syncPersistedLanguage, useSettingsStore } from './stores/settingsStore'
import { useUiStore } from './stores/uiStore'
import './i18n'
import './styles/index.css'

// 桌宠窗口与主窗口共用一份渲染层，按 ?window=pet 区分；桌宠窗口不挂路由
const isPetWindow = new URLSearchParams(window.location.search).get('window') === 'pet'

// 持久化的语言偏好需要在 i18n 初始化后同步（首次启动由 detector 给出默认）。
// 只有确实存在持久化的用户选择（amadeus_settings）时才同步：首次启动时 store
// 里只是初始默认 'zh'，若拿来同步会覆盖 detector 按系统语言解析的结果，还会
// 经由 changeLanguage 的缓存把 detector 的缓存一并改写成 'zh'
if (localStorage.getItem('amadeus_settings') !== null) {
  syncPersistedLanguage()
}

// 会话数据初始化（身份解析 + 会话列表拉取），不阻塞首屏渲染
void useSessionStore.getState().init()

if (!isPetWindow) bindMainWindowToAppMode()

// 开发期 E2E 测试钩子：暴露 store 供 CDP 驱动断言
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__amadeus = {
    sessionStore: useSessionStore,
    uiStore: useUiStore,
    live2dStore: useLive2dStore,
    live2dSpeechStore: useLive2dSpeechStore,
    companionStore: useCompanionStore,
    settingsStore: useSettingsStore
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('#root container not found')

createRoot(container).render(
  <StrictMode>
    {isPetWindow ? (
      <PetRoot />
    ) : (
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: 'var(--foreground)',
              color: 'var(--accent-ink)',
              border: 'none',
              boxShadow: 'var(--shadow-pop)',
              fontSize: '13.5px'
            }
          }}
        />
      </TooltipProvider>
    )}
  </StrictMode>
)
