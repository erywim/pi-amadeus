import { Suspense, lazy } from 'react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router'
import { useSettingsStore } from './stores/settingsStore'

/**
 * 路由器辅助组件（从 router.tsx 拆出，保持路由表纯声明、fast-refresh 干净）。
 */

// 陪伴页懒加载：pixi.js + pixi-live2d-display 约 1.5MB，
// 只有进入 /companion 才解析，文本模式启动不付这笔成本
const CompanionPage = lazy(() => import('./features/live2d/CompanionPage'))

export function CompanionRoute(): React.JSX.Element {
  return (
    <Suspense fallback={<CompanionFallback />}>
      <CompanionPage />
    </Suspense>
  )
}

function CompanionFallback(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center justify-center bg-stage">
      <span className="crt-flicker font-mono text-sm tracking-[0.3em] text-primary/70">
        {t('live2d.loading')}
      </span>
    </div>
  )
}

/** 首页重定向到用户选择的默认模式（设置-通用） */
export function IndexRedirect(): React.JSX.Element {
  const defaultMode = useSettingsStore((s) => s.defaultMode)
  return <Navigate to={defaultMode === 'text' ? '/text' : '/companion'} replace />
}
