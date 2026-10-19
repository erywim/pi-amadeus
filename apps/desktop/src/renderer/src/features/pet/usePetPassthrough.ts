import { useEffect } from 'react'
import type { Live2DEngine } from '@renderer/features/live2d/lib/live2d-engine'

/** 带此属性的元素（对话框等）与角色网格一样算可交互：光标在其上时关闭穿透 */
export const PET_INTERACTIVE_ATTR = 'data-pet-interactive'

function overInteractiveDom(x: number, y: number): boolean {
  return document.elementFromPoint(x, y)?.closest(`[${PET_INTERACTIVE_ATTR}]`) != null
}

/**
 * 鼠标穿透的渲染层一半：对主进程推来的光标坐标做命中检测，
 * 落在角色可见网格或可交互元素上时请求关闭穿透，离开时恢复；只在结果变化时上报。
 */
export function usePetPassthrough(engine: Live2DEngine | null): void {
  useEffect(() => {
    if (!engine) return
    let interactive = false
    const off = window.api.pet.onCursor(({ x, y }) => {
      const next = overInteractiveDom(x, y) || engine.hitTest(x, y)
      if (next === interactive) return
      interactive = next
      window.api.pet.setInteractive(next)
    })
    return () => {
      off()
      if (interactive) window.api.pet.setInteractive(false)
    }
  }, [engine])
}
