import * as React from 'react'
import { useEffect, useState } from 'react'
import { cn } from '@renderer/lib/utils'
import { Live2DStage } from '@renderer/features/live2d/Live2DStage'
import type { Live2DEngine, Placement } from '@renderer/features/live2d/lib/live2d-engine'
import { poke } from '@renderer/features/live2d/poke'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { usePetStore } from '@renderer/stores/petStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import {
  clampPlacement,
  defaultPlacement,
  fromStored,
  HEIGHT_MAX_RATIO,
  HEIGHT_MIN_RATIO,
  scaleAroundFeet,
  toStored,
  type Size
} from './placement'
import { PetDialog } from './PetDialog'
import { PetEscapeBadge } from './PetEscapeBadge'
import { usePetDrag } from './usePetDrag'
import { usePetPassthrough } from './usePetPassthrough'

const viewSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight })
/** 滚轮缩放的灵敏度（deltaY 每 100 约 16%） */
const WHEEL_SCALE_SPEED = 0.0015

/**
 * 桌宠窗口根组件（?window=pet）：铺满显示器工作区的透明窗口，只画角色。
 * 模型就绪 → 摆到上次的位置（首次为右下角）→ 再等两帧（摆好的首帧已上屏）通知主进程显示窗口，
 * 主进程随即隐藏主窗口，切换无闪烁。模型加载失败直接退回窗口模式。
 * 角色上：拖动换位置（松手后记住），点一下戳她。
 */
export default function PetApp(): React.JSX.Element {
  const [engine, setEngine] = useState<Live2DEngine | null>(null)
  const [dialogReopen, setDialogReopen] = useState(0)
  const { hold, forced } = usePetPassthrough(engine)
  const modelId = useLive2dStore((s) => s.modelId)
  const saveStoredPlacement = usePetStore((s) => s.setPlacement)

  // 桌宠窗口是独立的渲染层，语音回合接着最新会话继续（与陪伴页的默认选中一致），
  // 这样退出桌宠后主窗口刷新会话就能看到这轮对话
  const userId = useSessionStore((s) => s.userId)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  useEffect(() => {
    if (userId && !activeSessionId && sessions.length > 0) selectSession(sessions[0]!.id)
  }, [userId, activeSessionId, sessions, selectSession])

  function clamp(p: Placement): Placement {
    const size = engine?.getModelSize()
    return size ? clampPlacement(p, viewSize(), size) : p
  }

  const { dragging, handlers } = usePetDrag({
    engine,
    hold,
    clamp,
    onTap: () => {
      poke(engine)
      setDialogReopen((n) => n + 1)
    },
    onDragEnd: (p) => saveStoredPlacement(modelId, toStored(p, viewSize()))
  })

  useEffect(() => {
    document.documentElement.classList.add('pet-window')
    document.body.classList.add('theme-amadeus')
  }, [])

  /**
   * 滚轮在角色身上：按滚轮方向缩放，脚底位置不变；改完立刻存进 pet_config，
   * 下次进入桌宠与位置一起恢复。对话框上滚动不缩放。
   */
  function handleWheel(e: React.WheelEvent<HTMLDivElement>): void {
    const size = engine?.getModelSize()
    const placement = engine?.getPlacement()
    if (!engine || !size || !placement) return
    if (!engine.hitTest(e.clientX, e.clientY)) return
    const view = viewSize()
    const minScale = (view.height * HEIGHT_MIN_RATIO) / size.height
    const maxScale = (view.height * HEIGHT_MAX_RATIO) / size.height
    const nextScale = Math.min(Math.max(placement.scale * Math.exp(-e.deltaY * WHEEL_SCALE_SPEED), minScale), maxScale)
    // 缩放中 → 新尺寸：以脚底为锚点，再按窗口边界收回
    const next = clamp(scaleAroundFeet(placement, size, nextScale))
    engine.setPlacement(next)
    saveStoredPlacement(modelId, toStored(next, view))
  }

  function handleReady(ready: Live2DEngine): void {
    const size = ready.getModelSize()
    if (size) {
      const view = viewSize()
      const stored = usePetStore.getState().placements[modelId] ?? null
      const restored = stored ? fromStored(stored, view) : null
      ready.setPlacement(clampPlacement(restored ?? defaultPlacement(view, size), view, size))
    }
    setEngine(ready)
    requestAnimationFrame(() => requestAnimationFrame(() => window.api.pet.ready()))
  }

  return (
    <div
      className={cn('relative h-screen w-screen overflow-hidden', dragging ? 'cursor-grabbing' : 'cursor-grab')}
      onContextMenu={(e) => {
        // 桌宠窗口没有可见的窗口边框：右键菜单是回到窗口模式的出口
        e.preventDefault()
        window.api.pet.openMenu()
      }}
      onWheel={handleWheel}
      {...handlers}
    >
      <Live2DStage placement="free" onReady={handleReady} onError={() => window.api.setMode('window')} />
      <PetDialog engine={engine} reopenSignal={dialogReopen} />
      {/* 强制穿透时角色不可点：右上角的兜底 logo 仍然可点，用来关掉穿透或回到窗口 */}
      <PetEscapeBadge forced={forced} />
    </div>
  )
}
