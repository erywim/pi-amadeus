import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { RouterProvider } from 'react-router/dom'
import { TooltipProvider } from './components/ui/tooltip'
import { router } from './router'
import { useLive2dStore } from './stores/live2dStore'
import { useSessionStore } from './stores/sessionStore'
import { syncPersistedLanguage } from './stores/settingsStore'
import { useUiStore } from './stores/uiStore'
import './i18n'
import './styles/index.css'

// 持久化的语言偏好需要在 i18n 初始化后同步（首次启动由 detector 给出默认）
syncPersistedLanguage()

// 会话数据初始化（身份解析 + 会话列表拉取），不阻塞首屏渲染
void useSessionStore.getState().init()

// 开发期 E2E 测试钩子：暴露 store 供 CDP 驱动断言
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__amadeus = {
    sessionStore: useSessionStore,
    uiStore: useUiStore,
    live2dStore: useLive2dStore
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('#root container not found')

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#0d131b',
            color: '#e6edf3',
            border: '1px solid #1c2530'
          }
        }}
      />
    </TooltipProvider>
  </StrictMode>
)
