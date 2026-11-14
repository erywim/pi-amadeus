import { create } from 'zustand'
import type { ProviderInput, ProviderItem, ProviderTestResult } from '@pi-amadeus/shared'
import {
  activateProviderApi,
  createProviderApi,
  deleteProviderApi,
  fetchProviders,
  testProviderApi,
  updateProviderApi
} from '@renderer/lib/api'

/**
 * 模型服务列表（参考常见的多模型服务 的 Providers）：同一时间只有一个激活服务，
 * 激活服务优先于设置页的内置单条配置。密钥只存在服务端。
 */
interface ProviderState {
  providers: ProviderItem[]
  loaded: boolean
  loading: boolean
  load: () => Promise<void>
  create: (input: ProviderInput) => Promise<void>
  update: (id: string, input: ProviderInput) => Promise<void>
  remove: (id: string) => Promise<void>
  activate: (id: string) => Promise<void>
  test: (id: string) => Promise<ProviderTestResult>
}

export const useProviderStore = create<ProviderState>()((set, get) => ({
  providers: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loaded || get().loading) return
    set({ loading: true })
    try {
      set({ providers: await fetchProviders(), loaded: true })
    } catch (error) {
      console.warn('[providers] 加载失败：', error)
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  create: async (input) => {
    const provider = await createProviderApi(input)
    set((s) => ({ providers: [...s.providers, provider] }))
  },

  update: async (id, input) => {
    const provider = await updateProviderApi(id, input)
    set((s) => ({ providers: s.providers.map((item) => (item.id === id ? provider : item)) }))
  },

  remove: async (id) => {
    await deleteProviderApi(id)
    set((s) => ({ providers: s.providers.filter((item) => item.id !== id) }))
  },

  activate: async (id) => {
    const provider = await activateProviderApi(id)
    set((s) => ({
      providers: s.providers.map((item) =>
        item.id === id ? provider : { ...item, active: false }
      )
    }))
  },

  test: (id) => testProviderApi(id)
}))

/** 当前激活服务（没有则为 undefined，界面回落到内置配置） */
export function activeProviderOf(providers: ProviderItem[]): ProviderItem | undefined {
  return providers.find((provider) => provider.active && provider.enabled)
}
