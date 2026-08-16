import { Suspense, lazy } from 'react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, createBrowserRouter } from 'react-router'
import AppShell from './components/layout/AppShell'
import ChatPage from './features/chat/ChatPage'
import HistoryPage from './features/history/HistoryPage'
import SettingsPage from './features/settings/SettingsPage'

// Live2D 场景页懒加载：pixi.js + pixi-live2d-display 约 1.5MB，
// 只有进入 /live2d 才解析，聊天页启动不付这笔成本
const Live2DPage = lazy(() => import('./features/live2d/Live2DPage'))

function Live2DFallback(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <span className="crt-flicker font-mono text-sm tracking-[0.3em] text-cyber-cyan text-glow-cyan">
        {t('live2d.loading')}
      </span>
    </div>
  )
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> }
    ]
  },
  {
    path: '/live2d',
    element: (
      <Suspense fallback={<Live2DFallback />}>
        <Live2DPage />
      </Suspense>
    )
  }
])
