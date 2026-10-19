import { useCallback, useEffect, useRef } from 'react'
import type { Live2DEngine } from '@renderer/features/live2d/lib/live2d-engine'

/** 带此属性的元素（对话框等）与角色网格一样算可交互：光标在其上时关闭穿透 */
export const PET_INTERACTIVE_ATTR = 'data-pet-interactive'

function overInteractiveDom(x: number, y: number): boolean {
  return document.elementFromPoint(x, y)?.closest(`[${PET_INTERACTIVE_ATTR}]`) != null
}

/**
 * 鼠标穿透的渲染层一半：对主进程推来的光标坐标做命中检测，
 * 落在角色可见网格或可交互元素上时请求关闭穿透，离开时恢复；只在结果变化时上报。
 * 返回 hold(on)：指针按住期间（拖动）保持可交互，拖出网格也不切回穿透；松开后按当前光标重算。
 */
export function usePetPassthrough(engine: Live2DEngine | null): (hold: boolean) => void {
  const holdRef = useRef(false)
  const evaluateRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!engine) return
    let interactive = false
    let cursor: { x: number; y: number } | null = null
    const evaluate = (): void => {
      const over = cursor !== null && (overInteractiveDom(cursor.x, cursor.y) || engine.hitTest(cursor.x, cursor.y))
      const next = holdRef.current || over
      if (next === interactive) return
      interactive = next
      window.api.pet.setInteractive(next)
    }
    evaluateRef.current = evaluate
    const off = window.api.pet.onCursor((point) => {
      cursor = point
      evaluate()
    })
    return () => {
      off()
      evaluateRef.current = () => undefined
      if (interactive) window.api.pet.setInteractive(false)
    }
  }, [engine])

  return useCallback((hold: boolean) => {
    holdRef.current = hold
    evaluateRef.current()
  }, [])
}
