import type { Placement } from '@renderer/features/live2d/lib/live2d-engine'
import type { Size } from '@renderer/features/live2d/lib/placement'
import type { StoredPetPlacement } from '@renderer/stores/petStore'

// 边界夹取与脚底锚点缩放与陪伴舞台共用同一套数学（见 live2d/lib/placement）
export {
  clampPlacement,
  HEIGHT_MAX_RATIO,
  HEIGHT_MIN_RATIO,
  scaleAroundFeet,
  type Size
} from '@renderer/features/live2d/lib/placement'

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

export function toStored(p: Placement, view: Size): StoredPetPlacement {
  return { fx: p.x / view.width, fy: p.y / view.height, scale: p.scale }
}

/** 读回存储的位置；数值不合法（被手改坏等）时 null，按默认位置处理 */
export function fromStored(s: StoredPetPlacement, view: Size): Placement | null {
  if (![s.fx, s.fy, s.scale].every(Number.isFinite) || s.scale <= 0) return null
  return { x: s.fx * view.width, y: s.fy * view.height, scale: s.scale }
}
