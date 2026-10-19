import * as React from 'react'
import { useRef, useState } from 'react'
import type { Live2DEngine, Placement } from '@renderer/features/live2d/lib/live2d-engine'

// 点按 / 拖动判定阈值（与 XnneHangLab 一致）
const TAP_MAX_MS = 200
const DRAG_START_PX = 5

interface Press {
  pointerId: number
  downX: number
  downY: number
  downAt: number
  start: Placement
  dragging: boolean
}

interface PetDragOptions {
  engine: Live2DEngine | null
  /** 按住期间保持可交互（见 usePetPassthrough） */
  hold: (hold: boolean) => void
  /** 拖动中的位置限制（不让角色被拖出窗口） */
  clamp: (placement: Placement) => Placement
  onTap: () => void
  onDragEnd: (placement: Placement) => void
}

/**
 * 角色上的指针手势（XnneHangLab 的点按/拖动判定）：
 * 在角色网格上按下 → 移动超过 5px，或按住超过 200ms 且有移动 → 拖动，角色跟着指针走；
 * 200ms 内松开且移动不足 5px → 点按。指针捕获保证快速拖出网格时不丢事件。
 */
export function usePetDrag({ engine, hold, clamp, onTap, onDragEnd }: PetDragOptions): {
  dragging: boolean
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
  }
} {
  const press = useRef<Press | null>(null)
  const [dragging, setDragging] = useState(false)

  function onPointerDown(e: React.PointerEvent<HTMLElement>): void {
    if (e.button !== 0 || press.current || !engine) return
    const start = engine.getPlacement()
    if (!start || !engine.hitTest(e.clientX, e.clientY)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    press.current = { pointerId: e.pointerId, downX: e.clientX, downY: e.clientY, downAt: performance.now(), start, dragging: false }
    hold(true)
  }

  function onPointerMove(e: React.PointerEvent<HTMLElement>): void {
    const p = press.current
    if (!p || e.pointerId !== p.pointerId || !engine) return
    const dx = e.clientX - p.downX
    const dy = e.clientY - p.downY
    const distance = Math.hypot(dx, dy)
    if (!p.dragging && (distance > DRAG_START_PX || (performance.now() - p.downAt > TAP_MAX_MS && distance > 1))) {
      p.dragging = true
      setDragging(true)
    }
    if (p.dragging) engine.setPlacement(clamp({ ...p.start, x: p.start.x + dx, y: p.start.y + dy }))
  }

  function finish(e: React.PointerEvent<HTMLElement>, allowTap: boolean): void {
    const p = press.current
    if (!p || e.pointerId !== p.pointerId) return
    press.current = null
    hold(false)
    if (p.dragging) {
      setDragging(false)
      const placement = engine?.getPlacement()
      if (placement) onDragEnd(placement)
      return
    }
    const moved = Math.hypot(e.clientX - p.downX, e.clientY - p.downY)
    if (allowTap && performance.now() - p.downAt < TAP_MAX_MS && moved < DRAG_START_PX) onTap()
  }

  return {
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e) => finish(e, true),
      onPointerCancel: (e) => finish(e, false)
    }
  }
}
