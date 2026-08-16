import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Emotion } from '@pi-amadeus/shared'

/**
 * Live2D 驱动状态。Live2DStage 用 store.subscribe 命令式消费
 * （引擎调用是副作用，不走 React 每帧渲染）。
 */
interface Live2dState {
  emotion: Emotion
  /** 口型开合值 0..1：ttsPlayer 用 AnalyserNode 实时 RMS 驱动 */
  lipSyncValue: number
  avatar: {
    scale: number
    positionX: number
    positionY: number
  }

  setEmotion: (emotion: Emotion) => void
  setLipSyncValue: (value: number) => void
  setAvatar: (patch: Partial<Live2dState['avatar']>) => void
}

export const DEFAULT_AVATAR = {
  scale: 0.42,
  positionX: 0,
  positionY: 24
}

export const useLive2dStore = create<Live2dState>()(
  persist(
    (set) => ({
      emotion: 'neutral',
      lipSyncValue: 0,
      avatar: DEFAULT_AVATAR,

      setEmotion: (emotion) => set({ emotion }),
      setLipSyncValue: (lipSyncValue) => set({ lipSyncValue }),
      setAvatar: (patch) => set((s) => ({ avatar: { ...s.avatar, ...patch } }))
    }),
    {
      name: 'live2d_config',
      partialize: (state) => ({ avatar: state.avatar })
    }
  )
)
