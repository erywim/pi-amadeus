import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Emotion, Gesture } from '@pi-amadeus/shared'
import { createGuardedJsonStorage } from '@renderer/lib/guardedStorage'

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
      storage: createGuardedJsonStorage<Live2dConfigPersist>('live2dStore'),
      partialize: (state) => ({ avatar: state.avatar })
    }
  )
)
