import type { Placement } from './live2d-engine'

/** 容器 / 模型画布的像素尺寸 */
export interface Size {
  width: number
  height: number
}

/** 自定义大小的范围：身高占容器高度的比例（滚轮缩放按这个上下限夹住） */
export const HEIGHT_MIN_RATIO = 0.2
export const HEIGHT_MAX_RATIO = 1.2
/** 拖到容器边缘时，模型画布至少留在容器内的比例（防止拖丢） */
export const MIN_VISIBLE_RATIO = 0.3

/** 限制位置：模型画布每个方向至少 MIN_VISIBLE_RATIO 留在容器内 */
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
