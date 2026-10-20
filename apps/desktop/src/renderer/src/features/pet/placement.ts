import type { Placement } from '@renderer/features/live2d/lib/live2d-engine'
import type { StoredPetPlacement } from '@renderer/stores/petStore'

export interface Size {
  width: number
  height: number
}

/** 默认身高：占工作区高度的比例 */
const DEFAULT_HEIGHT_RATIO = 0.5
/** 自定义大小的范围：身高占工作区高度的比例（滚轮缩放按这个上下限夹住） */
export const HEIGHT_MIN_RATIO = 0.2
export const HEIGHT_MAX_RATIO = 1.2
/** 拖到窗口边缘时，模型画布至少留在窗口内的比例（防止拖丢） */
const MIN_VISIBLE_RATIO = 0.3

/** 首次进入桌宠：右下角，脚底贴着工作区底边（Dock / 任务栏上沿） */
export function defaultPlacement(view: Size, model: Size): Placement {
  const scale = (view.height * DEFAULT_HEIGHT_RATIO) / model.height
  return {
    x: view.width - (model.width * scale) / 2,
    y: view.height - (model.height * scale) / 2,
    scale
  }
}

/** 限制位置：模型画布每个方向至少 MIN_VISIBLE_RATIO 留在窗口内 */
export function clampPlacement(p: Placement, view: Size, model: Size): Placement {
  const w = model.width * p.scale
  const h = model.height * p.scale
  const keepX = w * MIN_VISIBLE_RATIO
  const keepY = h * MIN_VISIBLE_RATIO
  return {
    x: Math.min(Math.max(p.x, keepX - w / 2), view.width - keepX + w / 2),
    y: Math.min(Math.max(p.y, keepY - h / 2), view.height - keepY + h / 2),
    scale: p.scale
  }
}

/**
 * 换一个缩放：以脚底为锚点（她长高时脚不动，头往上长），返回新摆放。
 * 只改 scale 会让模型中心不动、脚底跟着抬高，看起来像"飘起来"。
 */
export function scaleAroundFeet(p: Placement, model: Size, scale: number): Placement {
  const h = model.height * p.scale
  const nextH = model.height * scale
  return { x: p.x, y: p.y + (h - nextH) / 2, scale }
}

export function toStored(p: Placement, view: Size): StoredPetPlacement {
  return { fx: p.x / view.width, fy: p.y / view.height, scale: p.scale }
}

/** 读回存储的位置；数值不合法（被手改坏等）时 null，按默认位置处理 */
export function fromStored(s: StoredPetPlacement, view: Size): Placement | null {
  if (![s.fx, s.fy, s.scale].every(Number.isFinite) || s.scale <= 0) return null
  return { x: s.fx * view.width, y: s.fy * view.height, scale: s.scale }
}
