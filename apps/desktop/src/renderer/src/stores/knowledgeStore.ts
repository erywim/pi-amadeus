import { create } from 'zustand'
import type { KnowledgeBase, KnowledgeDoc, KnowledgeSearchHit } from '@pi-amadeus/shared'
import {
  createKnowledgeBaseApi,
  deleteKnowledgeBaseApi,
  deleteKnowledgeDocApi,
  fetchKnowledgeBases,
  fetchKnowledgeDocs,
  importKnowledgeFileApi,
  importKnowledgeTextApi,
  importKnowledgeUrlApi,
  searchKnowledgeApi
} from '@renderer/lib/api'

/**
 * 知识库：列表、当前库的文档、检索预览。
 * 所有内容都来自服务端 SQLite 里真实导入的文档；没有导入就是空列表。
 */
interface KnowledgeState {
  bases: KnowledgeBase[]
  totals: { docs: number; chunks: number }
  activeId: string | null
  docs: KnowledgeDoc[]
  hits: KnowledgeSearchHit[]
  loading: boolean
  searchLoading: boolean
  load: (userId: string) => Promise<void>
  select: (userId: string, id: string) => Promise<void>
  create: (userId: string, name: string, description: string) => Promise<KnowledgeBase>
  remove: (userId: string, id: string) => Promise<void>
  importText: (userId: string, id: string, name: string, content: string) => Promise<void>
  importFile: (userId: string, id: string, file: File) => Promise<void>
  importUrl: (userId: string, id: string, url: string) => Promise<void>
  removeDoc: (userId: string, id: string, docId: string) => Promise<void>
  search: (userId: string, id: string, query: string) => Promise<void>
  clearHits: () => void
}

export const useKnowledgeStore = create<KnowledgeState>()((set, get) => ({
  bases: [],
  totals: { docs: 0, chunks: 0 },
  activeId: null,
  docs: [],
  hits: [],
  loading: false,
  searchLoading: false,

  load: async (userId) => {
    set({ loading: true })
    try {
      const result = await fetchKnowledgeBases(userId)
      set({ bases: result.bases, totals: result.totals })
      const activeId = get().activeId
      const stillThere = activeId && result.bases.some((base) => base.id === activeId)
      if (!stillThere) {
        set({ activeId: null, docs: [], hits: [] })
      } else if (activeId) {
        const docs = await fetchKnowledgeDocs(activeId, userId)
        set({ docs })
      }
    } catch (error) {
      console.warn('[knowledge] 加载失败：', error)
    } finally {
      set({ loading: false })
    }
  },

  select: async (userId, id) => {
    set({ activeId: id, hits: [] })
    try {
      const docs = await fetchKnowledgeDocs(id, userId)
      set({ docs })
    } catch (error) {
      console.warn('[knowledge] 文档加载失败：', error)
      set({ docs: [] })
    }
  },

  create: async (userId, name, description) => {
    const base = await createKnowledgeBaseApi({ userId, name, description })
    set((s) => ({
      bases: [...s.bases, base],
      totals: { ...s.totals }
    }))
    await get().select(userId, base.id)
    await get().load(userId)
    return base
  },

  remove: async (userId, id) => {
    await deleteKnowledgeBaseApi(id, userId)
    set((s) => ({
      bases: s.bases.filter((base) => base.id !== id),
      ...(s.activeId === id ? { activeId: null, docs: [], hits: [] } : {})
    }))
    await get().load(userId)
  },

  importText: async (userId, id, name, content) => {
    await importKnowledgeTextApi(id, userId, { name, content })
    await refreshAfterImport(set, get, userId, id)
  },

  importFile: async (userId, id, file) => {
    await importKnowledgeFileApi(id, userId, file)
    await refreshAfterImport(set, get, userId, id)
  },

  importUrl: async (userId, id, url) => {
    await importKnowledgeUrlApi(id, userId, url)
    await refreshAfterImport(set, get, userId, id)
  },

  removeDoc: async (userId, id, docId) => {
    await deleteKnowledgeDocApi(docId)
    await refreshAfterImport(set, get, userId, id)
  },

  search: async (userId, id, query) => {
    if (!query.trim()) {
      set({ hits: [] })
      return
    }
    set({ searchLoading: true })
    try {
      set({ hits: await searchKnowledgeApi(id, userId, query) })
    } catch (error) {
      console.warn('[knowledge] 检索失败：', error)
      set({ hits: [] })
    } finally {
      set({ searchLoading: false })
    }
  },

  clearHits: () => set({ hits: [] })
}))

/** 导入/删除文档后：刷新当前库的文档列表与全局统计 */
async function refreshAfterImport(
  set: (partial: Partial<KnowledgeState>) => void,
  get: () => KnowledgeState,
  userId: string,
  id: string
): Promise<void> {
  const [docs, list] = await Promise.all([fetchKnowledgeDocs(id, userId), fetchKnowledgeBases(userId)])
  set({
    docs,
    bases: list.bases,
    totals: list.totals,
    ...(get().activeId === id ? {} : { activeId: id })
  })
}
