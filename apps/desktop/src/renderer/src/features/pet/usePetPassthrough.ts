import { useCallback, useEffect, useRef, useState } from 'react'
import type { Live2DEngine } from '@renderer/features/live2d/lib/live2d-engine'

/** 带此属性的元素（对话框等）与角色网格一样算可交互：光标在其上时关闭穿透 */
export const PET_INTERACTIVE_ATTR = 'data-pet-interactive'
/** 兜底 logo：强制穿透时唯一还能接管鼠标的区域 */
export const PET_ESCAPE_ATTR = 'data-pet-escape'

function overAttr(x: number, y: number, attr: string): boolean {
  return document.elementFromPoint(x, y)?.closest(`[${attr}]`) != null
}

/**
 * 鼠标穿透的渲染层一半：对主进程推来的光标坐标做命中检测，
 * 落在角色可见网格或可交互元素上时请求关闭穿透，离开时恢复；只在结果变化时上报。
 * 强制穿透（forced）时角色不接管鼠标，只有右上角的兜底 logo 例外——
 * 否则开了穿透就再也点不到任何入口。
 * 返回 hold(on)：指针按住期间（拖动）保持可交互，拖出网格也不切回穿透；松开后按当前光标重算。
 * 返回 forced：当前是否强制穿透（兜底 logo 据此显示）。
 */
export function usePetPassthrough(engine: Live2DEngine | null): {
  hold: (hold: boolean) => void
  forced: boolean
} {
  const holdRef = useRef(false)
  const forcedRef = useRef(false)
  const [forced, setForced] = useState(false)
  const evaluateRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!engine) return
    let interactive = false
    let escape = false
    let cursor: { x: number; y: number } | null = null
    const evaluate = (): void => {
      const over = cursor !== null && (overAttr(cursor.x, cursor.y, PET_INTERACTIVE_ATTR) || engine.hitTest(cursor.x, cursor.y))
      const next = holdRef.current || over
      if (next !== interactive) {
        interactive = next
        window.api.pet.setInteractive(next)
      }
      // 强制穿透 → 角色命中由主进程忽略，只有兜底 logo 的命中能接管鼠标
      const nextEscape = forcedRef.current && cursor !== null && overAttr(cursor.x, cursor.y, PET_ESCAPE_ATTR)
      if (nextEscape !== escape) {
        escape = nextEscape
        window.api.pet.setEscape(nextEscape)
      }
    }
    evaluateRef.current = evaluate
    const off = window.api.pet.onCursor((point) => {
      cursor = point
      evaluate()
    })
    // 穿透开关变化 → 强制穿透中 / 恢复时都要重算一次（logo 出现或消失）
    const offPassthrough = window.api.pet.onPassthrough((on) => {
      forcedRef.current = on
      setForced(on)
      evaluate()
    })
    return () => {
      off()
      offPassthrough()
      evaluateRef.current = () => undefined
      if (interactive) window.api.pet.setInteractive(false)
      if (escape) window.api.pet.setEscape(false)
    }
  }, [engine])

  return {
    hold: useCallback((on: boolean) => {
      holdRef.current = on
      evaluateRef.current()
    }, []),
    forced
  }
}
