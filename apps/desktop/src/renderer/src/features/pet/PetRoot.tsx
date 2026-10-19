import { Suspense, lazy } from 'react'
import { Toaster } from 'react-hot-toast'
import type * as React from 'react'

// 桌宠窗口只加载角色与对话框；pixi.js + pixi-live2d-display 随 PetApp 懒加载
const PetApp = lazy(() => import('./PetApp'))

/** 桌宠窗口入口（main.tsx 按 ?window=pet 挂载，代替路由） */
export function PetRoot(): React.JSX.Element {
  return (
    <>
      <Suspense fallback={null}>
        <PetApp />
      </Suspense>
      {/* 语音链路用 toast 报告麦克风/大脑错误：桌宠窗口没有主应用的其他 UI，也得有 toast */}
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
    </>
  )
}
