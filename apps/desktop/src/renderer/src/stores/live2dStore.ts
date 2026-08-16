import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Emotion } from '@pi-amadeus/shared'

/**
 * Live2D 驱动状态。Live2DStage 用 store.subscribe 命令式消费
 * （引擎调用是副作用，不走 React 每帧渲染）。
 */
interface Live2dState {
  emotion: Emotion
  motion: { group: string; index: number } | null
  /** 口型开合值 0..1。M1 由静音正弦 LFO 假驱动，M4 换真实 TTS 幅度 */
  lipSyncValue: number
  avatar: {
    scale: number
    positionX: number
    positionY: number
  }

  setEmotion: (emotion: Emotion) => void
  setMotion: (motion: { group: string; index: number } | null) => void
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
      motion: null,
      lipSyncValue: 0,
      avatar: DEFAULT_AVATAR,

      setEmotion: (emotion) => set({ emotion }),
      setMotion: (motion) => set({ motion }),
      setLipSyncValue: (lipSyncValue) => set({ lipSyncValue }),
      setAvatar: (patch) => set((s) => ({ avatar: { ...s.avatar, ...patch } }))
    }),
    {
      name: 'live2d_config',
      partialize: (state) => ({ avatar: state.avatar })
    }
  )
)
