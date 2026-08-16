import { create } from 'zustand'
import type { Message, Session, StreamState, ToolStatus } from '@pi-amadeus/shared'
import {
  confirmTool,
  deleteSessionApi,
  fetchMessages,
  fetchSessions,
  getLocalUserId,
  getLocalUsername,
  resolveUserId,
  startChatTurn
} from '@renderer/lib/api'
import { useLive2dStore } from './live2dStore'

/**
 * 会话状态（真实后端）：sessions 列表 + 按会话懒加载的 messages 缓存 +
 * 当前流式状态。文本聊天走 /api/chat SSE；语音回合由 Live2D 页自行消费
 * /api/voice（音频播放需要实时调度），结束后调 refreshSession 同步落库数据。
 */
interface SessionState {
  sessions: Session[]
  messages: Record<string, Message[]>
  activeSessionId: string | null
  stream: StreamState
  userId: string | null
  /** 启动初始化是否完成（失败也置 true，避免反复重试） */
  initialized: boolean

  init: () => Promise<void>
  refreshSessions: () => Promise<void>
  refreshSession: (sessionId: string) => Promise<void>
  selectSession: (id: string) => void
  createSession: () => string
  /** 返回当前选中会话；无则新建（语音回合复用文本会话） */
  ensureActiveSession: () => string
  deleteSession: (id: string) => void
  sendMessage: (text: string) => void
  stopStreaming: () => void
  /** bash 确认卡应答（允许/拒绝） */
  respondToolConfirm: (approved: boolean) => void
}

export const useSessionStore = create<SessionState>()((set, get) => {
  let abortTurn: AbortController | null = null

  /** 结束当前回合流（中止 + 清空流状态） */
  function endStream(): void {
    abortTurn?.abort()
    abortTurn = null
    set({ stream: { streaming: false, tools: [] } })
  }

  return {
    sessions: [],
    messages: {},
    activeSessionId: null,
    stream: { streaming: false, tools: [] },
    userId: null,
    initialized: false,

    init: async () => {
      try {
        const username = getLocalUsername()
        const userId = getLocalUserId() ?? (await resolveUserId(username))
        const sessions = await fetchSessions(userId)
        set({ userId, sessions, initialized: true })
      } catch (error) {
        console.error('[session] 初始化失败：', error)
        set({ initialized: true })
      }
    },

    refreshSessions: async () => {
      const { userId } = get()
      if (!userId) return
      try {
        const sessions = await fetchSessions(userId)
        set((s) => ({
          sessions,
          // 刷新消息缓存中的 messageCount 等（仅当该会话当前没有流式草稿）
          messages: { ...s.messages }
        }))
      } catch (error) {
        console.warn('[session] 会话列表刷新失败：', error)
      }
    },

    refreshSession: async (sessionId) => {
      try {
        const messages = await fetchMessages(sessionId)
        set((s) => ({ messages: { ...s.messages, [sessionId]: messages } }))
        void get().refreshSessions()
      } catch (error) {
        console.warn('[session] 会话消息刷新失败：', error)
      }
    },

    selectSession: (id) => {
      set({ activeSessionId: id })
      const { messages } = get()
      // 懒加载：仅首次选中时拉取消息
      if (!(id in messages)) {
        void get().refreshSession(id)
      }
    },

    createSession: () => {
      const id = crypto.randomUUID()
      const now = Date.now()
      const session: Session = {
        id,
        channel: 'desktop',
        title: '',
        createdAt: now,
        updatedAt: now,
        messageCount: 0
      }
      set((s) => ({
        sessions: [session, ...s.sessions],
        messages: { ...s.messages, [id]: [] },
        activeSessionId: id
      }))
      return id
    },

    ensureActiveSession: () => {
      const { activeSessionId } = get()
      return activeSessionId ?? get().createSession()
    },

    deleteSession: (id) => {
      void deleteSessionApi(id).catch((error) => console.warn('[session] 删除失败：', error))
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== id)
        const messages = { ...s.messages }
        delete messages[id]
        return {
          sessions,
          messages,
          activeSessionId: s.activeSessionId === id ? null : s.activeSessionId
        }
      })
    },

    sendMessage: (text) => {
      const { activeSessionId, stream, userId } = get()
      if (stream.streaming || !activeSessionId || !userId) return

      const trimmed = text.trim()
      if (!trimmed) return

      const sessionId = activeSessionId
      const userMessage: Message = {
        id: `local-${Date.now()}-u`,
        sessionId,
        role: 'user',
        content: trimmed,
        ttsText: null,
        mode: 'text',
        createdAt: Date.now()
      }
      const draftId = `local-${Date.now()}-a`

      set((s) => ({
        messages: {
          ...s.messages,
          [sessionId]: [...(s.messages[sessionId] ?? []), userMessage]
        },
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, updatedAt: Date.now() } : x)),
        stream: { streaming: true, draft: { messageId: draftId, content: '' }, tools: [] }
      }))

      abortTurn = startChatTurn({ userId, sessionId, content: trimmed }, (event) => {
        const state = get()
        const draft = state.stream.draft
        switch (event.type) {
          case 'delta':
            if (!draft) return
            set((s) => ({
              stream: {
                ...s.stream,
                streaming: true,
                draft: { ...draft, content: draft.content + event.delta }
              }
            }))
            return
          case 'tool_start':
            set((s) => ({
              stream: {
                ...s.stream,
                turnId: event.turnId,
                tools: [
                  ...s.stream.tools.filter((t) => t.toolCallId !== event.toolCallId),
                  {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: event.args,
                    status: 'running'
                  }
                ]
              }
            }))
            return
          case 'tool_update':
            set((s) => ({
              stream: {
                ...s.stream,
                tools: s.stream.tools.map((t) =>
                  t.toolCallId === event.toolCallId ? { ...t, summary: event.partial } : t
                )
              }
            }))
            return
          case 'tool_end': {
            const denied = (event.details as { deniedReason?: string } | undefined)?.deniedReason
            let status: ToolStatus = event.isError ? 'error' : 'success'
            if (denied === 'blocked') status = 'blocked'
            else if (denied === 'user_denied') status = 'denied'
            else if (denied === 'timeout') status = 'timeout'
            set((s) => ({
              stream: {
                ...s.stream,
                tools: s.stream.tools.map((t) =>
                  t.toolCallId === event.toolCallId
                    ? { ...t, status, summary: event.result || undefined, details: event.details }
                    : t
                )
              }
            }))
            return
          }
          case 'tool_confirm':
            set((s) => ({
              stream: {
                ...s.stream,
                turnId: event.turnId,
                pendingConfirm: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args,
                  expiresAt: event.expiresAt
                }
              }
            }))
            return
          case 'emotion':
            useLive2dStore.getState().setEmotion(event.emotion)
            return
          case 'done': {
            const finalDraft = get().stream.draft
            if (!finalDraft) return
            const assistantMessage: Message = {
              id: event.messageId,
              sessionId,
              role: 'assistant',
              content: finalDraft.content,
              ttsText: null,
              mode: 'text',
              createdAt: Date.now()
            }
            set((s) => ({
              messages: {
                ...s.messages,
                [sessionId]: [...(s.messages[sessionId] ?? []), assistantMessage]
              },
              stream: { streaming: false, tools: [] }
            }))
            abortTurn = null
            // 标题是服务端首轮后异步生成的：静默刷新列表拿标题/消息数
            void get().refreshSessions()
            return
          }
          case 'error':
            console.warn('[session] 回合出错：', event.message)
            endStream()
            return
          case 'audio':
          case 'transcript':
            return
        }
      })
    },

    stopStreaming: () => {
      endStream()
    },

    respondToolConfirm: (approved) => {
      const { stream } = get()
      const confirm = stream.pendingConfirm
      if (!confirm) return
      // 乐观清除卡片；服务端回执失败且回合仍在流时恢复
      set((s) => ({ stream: { ...s.stream, pendingConfirm: undefined } }))
      void confirmTool({
        turnId: stream.turnId ?? '',
        toolCallId: confirm.toolCallId,
        approved
      }).catch((error) => {
        console.warn('[session] 工具确认回执失败：', error)
        if (get().stream.streaming && !get().stream.pendingConfirm) {
          set((s) => ({ stream: { ...s.stream, pendingConfirm: confirm } }))
        }
      })
    }
  }
})
