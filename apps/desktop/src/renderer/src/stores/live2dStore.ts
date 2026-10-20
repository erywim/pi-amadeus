import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Emotion, Gesture } from '@pi-amadeus/shared'
import { createGuardedJsonStorage } from '@renderer/lib/guardedStorage'
import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODEL_PROFILES,
  resolveModelId,
  type Live2dModelId,
  type ModelAvatar
} from '@renderer/features/live2d/lib/models'

/**
 * Live2D 驱动状态。Live2DStage 用 store.subscribe 命令式消费
 * （引擎调用是副作用，不走 React 每帧渲染）。
 * 高频的口型值不在这里（persist 每次 set 都写 localStorage），见 live2dSpeechStore。
 */
interface Live2dState {
  /** 当前模型；Live2DStage 以它为 effect 依赖，切换后重建舞台 */
  modelId: Live2dModelId
  /** 每个模型各自保存摆位：切到别的模型再切回来，原来的缩放/位置还在 */
  avatars: Record<Live2dModelId, ModelAvatar>
  emotion: Emotion
  /** 最近一次动作请求；seq 自增保证同名动作连续触发也能被订阅到 */
  gesture: { name: Gesture; seq: number } | null

  setModelId: (modelId: unknown) => void
  setEmotion: (emotion: Emotion) => void
  playGesture: (name: Gesture) => void
  setAvatar: (patch: Partial<ModelAvatar>) => void
}

export const DEFAULT_AVATARS = Object.fromEntries(
  MODEL_IDS.map((id) => [id, { ...MODEL_PROFILES[id].defaultAvatar }])
) as Record<Live2dModelId, ModelAvatar>

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 单个模型的摆位：字段缺失或脏数据回落该模型默认值 */
function resolveAvatar(saved: unknown, base: ModelAvatar): ModelAvatar {
  if (!saved || typeof saved !== 'object') return { ...base }
  const value = saved as Partial<ModelAvatar>
  return {
    scale: finite(value.scale, base.scale),
    positionX: finite(value.positionX, base.positionX),
    positionY: finite(value.positionY, base.positionY)
  }
}

/** 全部模型的摆位：新模型用默认值补齐，旧模型的脏字段单独回落 */
function resolveAvatars(saved: unknown): Record<Live2dModelId, ModelAvatar> {
  const raw = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  const out = {} as Record<Live2dModelId, ModelAvatar>
  for (const id of MODEL_IDS) out[id] = resolveAvatar(raw[id], MODEL_PROFILES[id].defaultAvatar)
  return out
}

/** live2d_config 的持久化内容（与 partialize 保持一致） */
type Live2dConfigPersist = Pick<Live2dState, 'modelId' | 'avatars'>

export const useLive2dStore = create<Live2dState>()(
  persist(
    (set) => ({
      modelId: DEFAULT_MODEL_ID,
      avatars: DEFAULT_AVATARS,
      emotion: 'neutral',
      gesture: null,

      setModelId: (modelId) => set({ modelId: resolveModelId(modelId) }),
      setEmotion: (emotion) => set({ emotion }),
      playGesture: (name) => set((s) => ({ gesture: { name, seq: (s.gesture?.seq ?? 0) + 1 } })),
      setAvatar: (patch) =>
        set((s) => ({
          avatars: { ...s.avatars, [s.modelId]: { ...s.avatars[s.modelId], ...patch } }
        }))
    }),
    {
      name: 'live2d_config',
      storage: createGuardedJsonStorage<Live2dConfigPersist>('live2dStore'),
      version: 1,
      partialize: (state) => ({ modelId: state.modelId, avatars: state.avatars }),
      // v0 只有单个 avatar（红莉栖）→ 归到 kurisu 名下；之后切模型不会互相覆盖摆位
      migrate: (persisted, version) => {
        const old = persisted as
          | (Partial<Live2dConfigPersist> & { avatar?: Partial<ModelAvatar> })
          | undefined
        const avatars = resolveAvatars(old?.avatars)
        if (version < 1 && old?.avatar) {
          avatars.kurisu = resolveAvatar(old.avatar, MODEL_PROFILES.kurisu.defaultAvatar)
        }
        return {
          modelId: version < 1 ? DEFAULT_MODEL_ID : resolveModelId(old?.modelId),
          avatars
        }
      },
      // 即使是当前版本，持久化内容也可能是手改/部分丢失（例如 avatars 缺键）：
      // 合并时按模型补齐默认值，保证 avatars[modelId] 永远存在。
      // persisted 为空 = 读取/解析失败（guardedStorage 已保留现场）或从未存过：
      // 此时必须保持内存里的现值，不能用默认值顶替（用户数据安全规则）。
      merge: (persisted, current) => {
        if (persisted === undefined || persisted === null) return current
        const old = persisted as Partial<Live2dConfigPersist>
        return {
          ...current,
          modelId: resolveModelId(old.modelId),
          avatars: resolveAvatars(old.avatars)
        }
      }
    }
  )
)
