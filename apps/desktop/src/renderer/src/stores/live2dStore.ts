import { create } from 'zustand'
import { createJSONStorage, persist, type PersistStorage } from 'zustand/middleware'
import type { Emotion, Gesture } from '@pi-amadeus/shared'

/**
 * Live2D 驱动状态。Live2DStage 用 store.subscribe 命令式消费
 * （引擎调用是副作用，不走 React 每帧渲染）。
 * 高频的口型值不在这里（persist 每次 set 都写 localStorage），见 live2dSpeechStore。
 */
interface Live2dState {
  emotion: Emotion
  /** 最近一次动作请求；seq 自增保证同名动作连续触发也能被订阅到 */
  gesture: { name: Gesture; seq: number } | null
  avatar: {
    scale: number
    positionX: number
    positionY: number
  }

  setEmotion: (emotion: Emotion) => void
  playGesture: (name: Gesture) => void
  setAvatar: (patch: Partial<Live2dState['avatar']>) => void
}

export const DEFAULT_AVATAR = {
  scale: 0.42,
  positionX: 0,
  positionY: 24
}

/** live2d_config 的持久化内容（与 partialize 保持一致） */
type Live2dConfigPersist = Pick<Live2dState, 'avatar'>

const jsonStorage = createJSONStorage<Live2dConfigPersist>(() => localStorage)

/**
 * live2d_config 的自定义持久化层（包一层 createJSONStorage）：
 * - 解析成功：同步刷新一份 <key>.bak（last-good），供将来损坏时恢复；
 * - 解析失败：保留现场（损坏原文另存 <key>.bad-<ISO时间戳>），优先从 .bak 恢复；
 *   恢复不可用才回 null，由 persist 走初始默认值——绝不静默用默认值覆盖损坏现场。
 * 备份/另存的写入失败（如配额满）不阻断主流程。健康路径行为与默认 storage 完全一致。
 */
const live2dConfigStorage: PersistStorage<Live2dConfigPersist> = {
  getItem: (name) => {
    // 从未持久化过：与默认 storage 一致回 null，走初始默认值
    const raw = localStorage.getItem(name)
    if (raw === null) return null
    try {
      const value = jsonStorage!.getItem(name)
      // last-good 随时刷新；备份写失败不影响主流程
      try {
        localStorage.setItem(`${name}.bak`, raw)
      } catch {
        /* 忽略备份失败 */
      }
      return value
    } catch {
      console.warn(`[live2dStore] ${name} 内容损坏，现场已另存 .bad-*，尝试从 .bak 恢复`)
      try {
        localStorage.setItem(`${name}.bad-${new Date().toISOString()}`, raw)
      } catch {
        /* 忽略另存失败 */
      }
      const bak = localStorage.getItem(`${name}.bak`)
      if (bak === null) return null
      try {
        return JSON.parse(bak)
      } catch {
        return null
      }
    }
  },
  setItem: (name, value) => {
    jsonStorage!.setItem(name, value)
  },
  removeItem: (name) => {
    jsonStorage!.removeItem(name)
  }
}

export const useLive2dStore = create<Live2dState>()(
  persist(
    (set) => ({
      emotion: 'neutral',
      gesture: null,
      avatar: DEFAULT_AVATAR,

      setEmotion: (emotion) => set({ emotion }),
      playGesture: (name) => set((s) => ({ gesture: { name, seq: (s.gesture?.seq ?? 0) + 1 } })),
      setAvatar: (patch) => set((s) => ({ avatar: { ...s.avatar, ...patch } }))
    }),
    {
      name: 'live2d_config',
      storage: live2dConfigStorage,
      partialize: (state) => ({ avatar: state.avatar })
    }
  )
)
