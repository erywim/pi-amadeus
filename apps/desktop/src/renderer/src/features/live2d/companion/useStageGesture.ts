import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import type { Live2DEngine, Placement } from '../lib/live2d-engine'
import { MODEL_PROFILES, type Live2dModelId, type ModelAvatar } from '../lib/models'
import { clampPlacement, HEIGHT_MIN_RATIO, scaleAroundFeet, type Size } from '../lib/placement'

// 点按 / 拖动判定与桌宠一致
const TAP_MAX_MS = 200
const DRAG_START_PX = 5
/** 滚轮缩放的灵敏度（deltaY 每 100 约 16%） */
const WHEEL_SCALE_SPEED = 0.0015
/**
 * 陪伴舞台的缩放上限：舞台高度的 150%。
 * 桌宠的默认身高是 50%，120% 足够；陪伴舞台默认摆位约 124%（画布含透明留白），
 * 沿用 120% 会在第一次向上滚时把角色夹小一截，看起来像"滚轮失灵"。
 */
const STAGE_MAX_HEIGHT_RATIO = 1.5

interface Press {
  pointerId: number
  downX: number
  downY: number
  downAt: number
  start: ModelAvatar
  dragging: boolean
}

interface StageGestureOptions {
  engine: Live2DEngine | null
  containerRef: React.RefObject<HTMLElement | null>
  modelId: Live2dModelId
}

function toPlacement(avatar: ModelAvatar, view: Size): Placement {
  return { x: view.width / 2 + avatar.positionX, y: view.height / 2 + avatar.positionY, scale: avatar.scale }
}

/** 摆放 → store 里的偏移；坐标取整（配置面板显示与持久化都更好读） */
function toAvatar(p: Placement, view: Size): ModelAvatar {
  return {
    scale: p.scale,
    positionX: Math.round(p.x - view.width / 2),
    positionY: Math.round(p.y - view.height / 2)
  }
}

/** 把摆位按边界夹取后写回偏移 */
function clampToAvatar(p: Placement, view: Size, model: Size): ModelAvatar {
  return toAvatar(clampPlacement(p, view, model), view)
}

/**
 * 陪伴舞台上的角色手势：从角色可见网格上按住拖动换位置，滚轮以脚底为锚点缩放。
 * 位置与缩放写回 live2dStore 的 avatars（按模型分别持久化，配置面板的滑块同源）。
 * 拖动中实时写 store：引擎订阅 avatars 变化，下一帧就按新位置绘制。
 */
export function useStageGesture({ engine, containerRef, modelId }: StageGestureOptions): {
  dragging: boolean
  view: Size
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
    onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => void
  }
  onWheel: (e: React.WheelEvent<HTMLElement>) => void
  /** 拖动松手后浏览器会补一个 click：调用方用它吞掉，避免顺带戳她 */
  consumeDragClick: () => boolean
} {
  const press = useRef<Press | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState<Size>({ width: 0, height: 0 })
  const setAvatar = useLive2dStore((s) => s.setAvatar)

  function measure(): Size | null {
    const el = containerRef.current
    if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return null
    return { width: el.clientWidth, height: el.clientHeight }
  }

  function currentAvatar(): ModelAvatar {
    return useLive2dStore.getState().avatars[modelId] ?? MODEL_PROFILES[modelId].defaultAvatar
  }

  // 配置面板的滑块是摆位的另一个入口：它不知道舞台尺寸，可能把角色滑出视野。
  // 外部写入越界时夹回可见范围（拖动路径自己已经夹过，这里不会产生额外写入）。
  useEffect(() => {
    if (!engine) return
    const unsubscribe = useLive2dStore.subscribe((state, prev) => {
      if (state.avatars === prev.avatars) return
      const el = containerRef.current
      const avatar = state.avatars[modelId]
      const model = engine.getModelSize()
      if (!el || el.clientWidth <= 0 || el.clientHeight <= 0 || !avatar || !model) return
      const size = { width: el.clientWidth, height: el.clientHeight }
      const next = clampToAvatar(toPlacement(avatar, size), size, model)
      if (next.positionX !== avatar.positionX || next.positionY !== avatar.positionY) setAvatar(next)
    })
    return unsubscribe
  }, [engine, modelId, containerRef, setAvatar])

  // 容器尺寸变化：窗口变小后旧偏移可能落到舞台外，夹回可见范围并记住。
  // 同时把尺寸给出去（落地影跟随角色需要）。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (): void => {
      const next = { width: el.clientWidth, height: el.clientHeight }
      if (next.width <= 0 || next.height <= 0) return
      setView((prev) => (prev.width === next.width && prev.height === next.height ? prev : next))
      const model = engine?.getModelSize()
      if (!model) return
      const avatar = useLive2dStore.getState().avatars[modelId]
      if (!avatar) return
      const clamped = clampToAvatar(toPlacement(avatar, next), next, model)
      // 只有越界才写 store：正常缩放窗口不产生一次多余的持久化
      if (clamped.positionX !== avatar.positionX || clamped.positionY !== avatar.positionY) {
        setAvatar(clamped)
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(el)
    update()
    return () => observer.disconnect()
  }, [engine, modelId, containerRef, setAvatar])

  function onPointerDown(e: React.PointerEvent<HTMLElement>): void {
    if (e.button !== 0 || press.current || !engine) return
    // 从舞台里的控件上按下不拖动角色（世界线计等）
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 只从角色的可见网格上开始拖动：空白处的按下留给戳她与其它交互
    if (!engine.hitTest(e.clientX - rect.left, e.clientY - rect.top)) return
    if (!measure() || !engine.getModelSize()) return
    e.currentTarget.setPointerCapture(e.pointerId)
    press.current = {
      pointerId: e.pointerId,
      downX: e.clientX,
      downY: e.clientY,
      downAt: performance.now(),
      start: currentAvatar(),
      dragging: false
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLElement>): void {
    const p = press.current
    if (!p || e.pointerId !== p.pointerId) return
    const dx = e.clientX - p.downX
    const dy = e.clientY - p.downY
    const distance = Math.hypot(dx, dy)
    if (!p.dragging && (distance > DRAG_START_PX || (performance.now() - p.downAt > TAP_MAX_MS && distance > 1))) {
      // 按下 → 拖动：拖动结束后浏览器仍会补一个 click，必须标记吞掉，
      // 否则一次拖动会顺带触发戳她的表演
      p.dragging = true
      suppressClick.current = true
      setDragging(true)
    }
    if (!p.dragging) return
    const size = measure()
    const model = engine?.getModelSize()
    if (!size || !model) return
    const start = toPlacement(p.start, size)
    setAvatar(clampToAvatar({ x: start.x + dx, y: start.y + dy, scale: start.scale }, size, model))
  }

  function finish(e: React.PointerEvent<HTMLElement>): void {
    const p = press.current
    if (!p || e.pointerId !== p.pointerId) return
    press.current = null
    if (!p.dragging) return
    setDragging(false)
    // click 在 pointerup 之后同步派发；定时器在本轮事件结束后清标记，
    // 这样 pointercancel / 拖出窗口没有补 click 时，下一次点击不会被误吞
    setTimeout(() => {
      suppressClick.current = false
    }, 0)
  }

  /** 捕获被系统收回（窗口失焦、元素变化）时复位拖动状态：否则会一直以为按钮还按着 */
  function onLostPointerCapture(e: React.PointerEvent<HTMLElement>): void {
    const p = press.current
    if (!p || e.pointerId !== p.pointerId) return
    press.current = null
    if (!p.dragging) return
    setDragging(false)
    setTimeout(() => {
      suppressClick.current = false
    }, 0)
  }

  function onWheel(e: React.WheelEvent<HTMLElement>): void {
    // 舞台里的控件（世界线计等）上滚轮不缩放
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    if (!engine) return
    const size = measure()
    const model = engine.getModelSize()
    if (!size || !model) return
    const avatar = currentAvatar()
    const minScale = (size.height * HEIGHT_MIN_RATIO) / model.height
    const maxScale = (size.height * STAGE_MAX_HEIGHT_RATIO) / model.height
    const nextScale = Math.min(
      Math.max(avatar.scale * Math.exp(-e.deltaY * WHEEL_SCALE_SPEED), minScale),
      maxScale
    )
    // 缩放 → 脚底不动；再按边界收回（往边缘放大也不会把角色推出舞台）
    const next = scaleAroundFeet(toPlacement(avatar, size), model, nextScale)
    setAvatar(clampToAvatar(next, size, model))
  }

  return {
    dragging,
    view,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture
    },
    onWheel,
    consumeDragClick: () => {
      if (!suppressClick.current) return false
      suppressClick.current = false
      return true
    }
  }
}
