import { create } from 'zustand'
import type { AutomationInput, AutomationItem } from '@pi-amadeus/shared'
import {
  createAutomationApi,
  deleteAutomationApi,
  fetchAutomationMessages,
  fetchAutomations,
  runAutomationApi,
  updateAutomationApi
} from '@renderer/lib/api'
import type { Message } from '@pi-amadeus/shared'

/** 自动化任务：真实调度器状态与运行结果，界面只展示数据库里的值 */
interface AutomationState {
  items: AutomationItem[]
  loaded: boolean
  loading: boolean
  /** automationId → 该任务的会话消息（展开运行记录时加载） */
  messages: Record<string, Message[]>
  load: (userId: string) => Promise<void>
  create: (userId: string, input: AutomationInput) => Promise<AutomationItem>
  update: (id: string, patch: Partial<AutomationInput>) => Promise<AutomationItem>
  remove: (id: string) => Promise<void>
  run: (id: string) => Promise<void>
  loadMessages: (id: string) => Promise<void>
}

export const useAutomationStore = create<AutomationState>()((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  messages: {},

  load: async (userId) => {
    if (get().loading) return
    set({ loading: true })
    try {
      set({ items: await fetchAutomations(userId), loaded: true })
    } catch (error) {
      console.warn('[automation] 加载失败：', error)
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  create: async (userId, input) => {
    const item = await createAutomationApi(userId, input)
    set((s) => ({ items: [item, ...s.items] }))
    return item
  },

  update: async (id, patch) => {
    const item = await updateAutomationApi(id, patch)
    set((s) => ({ items: s.items.map((existing) => (existing.id === id ? item : existing)) }))
    return item
  },

  remove: async (id) => {
    await deleteAutomationApi(id)
    set((s) => ({
      items: s.items.filter((item) => item.id !== id),
      messages: Object.fromEntries(Object.entries(s.messages).filter(([key]) => key !== id))
    }))
  },

  run: async (id) => {
    await runAutomationApi(id)
    // 立即把本地状态置为 running：否则轮询开始前界面仍显示上一次的结果
    set((s) => ({
      items: s.items.map((item) => (item.id === id ? { ...item, lastStatus: 'running' } : item))
    }))
  },

  loadMessages: async (id) => {
    try {
      const messages = await fetchAutomationMessages(id)
      set((s) => ({ messages: { ...s.messages, [id]: messages } }))
    } catch (error) {
      console.warn('[automation] 运行记录加载失败：', error)
    }
  }
}))
