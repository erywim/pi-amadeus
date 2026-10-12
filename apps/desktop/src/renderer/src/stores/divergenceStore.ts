import { create } from 'zustand'

/**
 * 世界线变动率：固定世界线序列轮询观测（冈部的观测值）。
 * value 只是"已落定"的读数；翻牌滚动动画由各显示组件本地完成。
 * 陪伴舞台的世界线计与文本模式侧栏脚部读数共享这一份状态。
 */
export const WORLD_LINES = ['1.048596', '0.571046', '1.130212', '0.409420'] as const

interface DivergenceState {
  /** 当前世界线序号（WORLD_LINES 下标） */
  index: number
  /** 当前世界线变动率 */
  value: string
  /** 观测下一条世界线 */
  next: () => void
}

export const useDivergenceStore = create<DivergenceState>()((set, get) => ({
  index: 0,
  value: WORLD_LINES[0]!,
  next: () => {
    const index = (get().index + 1) % WORLD_LINES.length
    set({ index, value: WORLD_LINES[index]! })
  }
}))
