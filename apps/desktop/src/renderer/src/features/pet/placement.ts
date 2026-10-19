import type { Placement } from '@renderer/features/live2d/lib/live2d-engine'

interface Size {
  width: number
  height: number
}

/** 默认身高：占工作区高度的比例 */
const DEFAULT_HEIGHT_RATIO = 0.5

/** 首次进入桌宠：右下角，脚底贴着工作区底边（Dock / 任务栏上沿） */
export function defaultPlacement(view: Size, model: Size): Placement {
  const scale = (view.height * DEFAULT_HEIGHT_RATIO) / model.height
  return {
    x: view.width - (model.width * scale) / 2,
    y: view.height - (model.height * scale) / 2,
    scale
  }
}
