import { create } from 'zustand'
import type { AffinitySummary, MemoryItem, MemoryKind } from '@pi-amadeus/shared'
import {
  addMemoryApi,
  deleteMemoryApi,
  fetchAffinity,
  fetchMemories,
  updateMemoryApi
} from '@renderer/lib/api'

/**
 * 长期记忆与好感度：全部来自大脑服务里的真实记录。
 * 不提供任何本地预置/示例数据——没有聊过就没有记忆，没有互动就没有好感。
 */
interface MemoryState {
  memories: MemoryItem[]
  total: number
  affinity: AffinitySummary | null
  loaded: boolean
  loading: boolean
  load: (userId: string) => Promise<void>
  refreshAffinity: (userId: string) => Promise<void>
  search: (userId: string, query: string) => Promise<void>
  add: (userId: string, content: string, kind: MemoryKind) => Promise<void>
  update: (id: string, patch: { content?: string; kind?: MemoryKind; pinned?: boolean }) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useMemoryStore = create<MemoryState>()((set, get) => ({
  memories: [],
  total: 0,
  affinity: null,
  loaded: false,
  loading: false,

  load: async (userId) => {
    if (get().loading) return
    set({ loading: true })
    try {
      const [list, affinity] = await Promise.all([fetchMemories(userId), fetchAffinity(userId)])
      set({
        memories: list.memories,
        total: list.total,
        affinity,
        loaded: true
      })
    } catch (error) {
      console.warn('[memory] 加载失败：', error)
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  refreshAffinity: async (userId) => {
    try {
      set({ affinity: await fetchAffinity(userId) })
    } catch (error) {
      console.warn('[memory] 好感度刷新失败：', error)
    }
  },

  search: async (userId, query) => {
    try {
      const list = await fetchMemories(userId, query)
      set({ memories: list.memories })
    } catch (error) {
      console.warn('[memory] 搜索失败：', error)
    }
  },

  add: async (userId, content, kind) => {
    const memory = await addMemoryApi(userId, content, kind)
    set((s) => ({ memories: [memory, ...s.memories], total: s.total + 1 }))
  },

  update: async (id, patch) => {
    const memory = await updateMemoryApi(id, patch)
    set((s) => ({ memories: s.memories.map((item) => (item.id === id ? memory : item)) }))
  },

  remove: async (id) => {
    await deleteMemoryApi(id)
    set((s) => ({
      memories: s.memories.filter((item) => item.id !== id),
      total: Math.max(0, s.total - 1)
    }))
  }
}))
