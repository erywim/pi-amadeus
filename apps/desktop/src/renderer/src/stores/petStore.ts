import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createGuardedJsonStorage } from '@renderer/lib/guardedStorage'
import { MODEL_IDS, type Live2dModelId } from '@renderer/features/live2d/lib/models'

/** 桌宠里角色的位置与缩放：锚点（模型中心）占窗口宽高的比例，换显示器/分辨率后保持相对位置 */
export interface StoredPetPlacement {
  fx: number
  fy: number
  scale: number
}

interface PetState {
  /** 按模型各存一份：切回红莉栖时不会套用别的模型的比例（模型画布尺寸差很多） */
  placements: Partial<Record<Live2dModelId, StoredPetPlacement>>
  setPlacement: (modelId: Live2dModelId, placement: StoredPetPlacement) => void
}

type PetPersist = Pick<PetState, 'placements'>

const valid = (p: unknown): p is StoredPetPlacement => {
  if (!p || typeof p !== 'object') return false
  const v = p as Partial<StoredPetPlacement>
  return [v.fx, v.fy, v.scale].every((n) => typeof n === 'number' && Number.isFinite(n)) && (v.scale ?? 0) > 0
}

/** 只保留字段合法、且模型 ID 仍然存在的摆位；坏数据按"没存过"处理（回到默认位置） */
function resolvePlacements(saved: unknown): Partial<Record<Live2dModelId, StoredPetPlacement>> {
  if (!saved || typeof saved !== 'object') return {}
  const out: Partial<Record<Live2dModelId, StoredPetPlacement>> = {}
  for (const [id, value] of Object.entries(saved as Record<string, unknown>)) {
    if (!MODEL_IDS.includes(id as Live2dModelId) || !valid(value)) continue
    out[id as Live2dModelId] = { fx: value.fx, fy: value.fy, scale: value.scale }
  }
  return out
}

/**
 * 桌宠状态（pet_config）。单独一个键、只由桌宠窗口写：若与主窗口共用
 * live2d_config，主窗口内存里的旧值会在它下次写入时把桌宠刚存的位置覆盖掉。
 */
export const usePetStore = create<PetState>()(
  persist(
    (set) => ({
      placements: {},
      setPlacement: (modelId, placement) =>
        set((s) => ({ placements: { ...s.placements, [modelId]: placement } }))
    }),
    {
      name: 'pet_config',
      storage: createGuardedJsonStorage<PetPersist>('petStore'),
      version: 1,
      partialize: (state) => ({ placements: state.placements }),
      // v0 只有单个 placement（红莉栖）→ 归到 kurisu 名下
      migrate: (persisted, version) => {
        const old = persisted as (Partial<PetPersist> & { placement?: StoredPetPlacement }) | undefined
        const placements = resolvePlacements(old?.placements)
        if (version < 1 && valid(old?.placement)) placements.kurisu = old.placement
        return { placements }
      },
      // 当前版本也可能有被手改/损坏的单条记录：逐条校验，坏的丢掉。
      // persisted 为空 = 读取/解析失败或从未存过 → 保持现值，不拿默认值顶替
      merge: (persisted, current) => {
        if (persisted === undefined || persisted === null) return current
        const old = persisted as Partial<PetPersist>
        return { ...current, placements: resolvePlacements(old.placements) }
      }
    }
  )
)
