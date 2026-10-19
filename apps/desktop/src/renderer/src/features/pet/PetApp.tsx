import * as React from 'react'
import { useEffect } from 'react'
import { Live2DStage } from '@renderer/features/live2d/Live2DStage'
import type { Live2DEngine } from '@renderer/features/live2d/lib/live2d-engine'
import { defaultPlacement } from './placement'

/**
 * 桌宠窗口根组件（?window=pet）：铺满显示器工作区的透明窗口，只画角色。
 * 模型就绪 → 摆到默认位置 → 再等两帧（摆好的首帧已上屏）通知主进程显示窗口，
 * 主进程随即隐藏主窗口，切换无闪烁。模型加载失败直接退回窗口模式。
 */
export default function PetApp(): React.JSX.Element {
  useEffect(() => {
    document.documentElement.classList.add('pet-window')
    document.body.classList.add('theme-amadeus')
  }, [])

  function handleReady(engine: Live2DEngine): void {
    const size = engine.getModelSize()
    if (size) engine.setPlacement(defaultPlacement({ width: window.innerWidth, height: window.innerHeight }, size))
    requestAnimationFrame(() => requestAnimationFrame(() => window.api.petReady()))
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <Live2DStage placement="free" onReady={handleReady} onError={() => window.api.setMode('window')} />
    </div>
  )
}
