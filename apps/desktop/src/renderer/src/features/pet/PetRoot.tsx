import { Suspense, lazy } from 'react'
import type * as React from 'react'

// 桌宠窗口只加载角色与对话框；pixi.js + pixi-live2d-display 随 PetApp 懒加载
const PetApp = lazy(() => import('./PetApp'))

/** 桌宠窗口入口（main.tsx 按 ?window=pet 挂载，代替路由） */
export function PetRoot(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <PetApp />
    </Suspense>
  )
}
