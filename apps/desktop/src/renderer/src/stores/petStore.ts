import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createGuardedJsonStorage } from '@renderer/lib/guardedStorage'

/** 桌宠里角色的位置与缩放：锚点（模型中心）占窗口宽高的比例，换显示器/分辨率后保持相对位置 */
export interface StoredPetPlacement {
  fx: number
  fy: number
  scale: number
}

interface PetState {
  /** null = 尚未摆放过，用默认位置（右下角） */
  placement: StoredPetPlacement | null
  setPlacement: (placement: StoredPetPlacement) => void
}

type PetPersist = Pick<PetState, 'placement'>

/**
 * 桌宠状态（pet_config）。单独一个键、只由桌宠窗口写：若与主窗口共用
 * live2d_config，主窗口内存里的旧值会在它下次写入时把桌宠刚存的位置覆盖掉。
 */
export const usePetStore = create<PetState>()(
  persist(
    (set) => ({
      placement: null,
      setPlacement: (placement) => set({ placement })
    }),
    {
      name: 'pet_config',
      storage: createGuardedJsonStorage<PetPersist>('petStore'),
      partialize: (state) => ({ placement: state.placement })
    }
  )
)
