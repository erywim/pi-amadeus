import { create } from 'zustand'
import type { Message, Session, StreamState, ToolActivityItem, ToolStatus } from '@pi-amadeus/shared'
import {
  confirmTool,
  deleteSessionApi,
  fetchCurrentUser,
  fetchMessages,
  fetchSessions,
  startChatTurn
} from '@renderer/lib/api'
import { useLive2dStore } from './live2dStore'
import { useLive2dSpeechStore } from './live2dSpeechStore'
import { useUiStore } from './uiStore'

/**
 * 回合工作过程日志：一个回合的工具活动快照 + 耗时（Codex 风格折叠卡的数据源）。
 * 不落库、仅内存：本会话窗口内可回看，重进页面后历史消息不带工作卡。
 */
export interface TurnWorkLog {
  tools: ToolActivityItem[]
  durationMs: number
  /** 被手动停止（发送键变停止键时点击）的回合 */
  stopped: boolean
}

/**
 * 渲染层用的流式状态：在共享 StreamState 上额外标注回合所属会话。
 * 流全局只有一条，但展示/归档只认产生它的会话（切换会话不串台）。
 */
interface SessionStreamState extends StreamState {
  /** 产生当前流的会话 id（sendMessage 时写入，回合结束随流状态一起清空） */
  sessionId?: string
}

/**
 * 会话状态（真实后端）：sessions 列表 + 按会话懒加载的 messages 缓存 +
 * 当前流式状态。文本聊天走 /api/chat SSE；语音回合由 Live2D 页自行消费
 * /api/voice（音频播放需要实时调度），结束后调 refreshSession 同步落库数据。
 */
interface SessionState {
  sessions: Session[]
  messages: Record<string, Message[]>
  activeSessionId: string | null
  stream: SessionStreamState
  userId: string | null
  /** 启动初始化是否完成（失败也置 true，避免反复重试） */
  initialized: boolean
  /** assistant 消息 id → 工作过程日志（回合正常结束时写入） */
  workLogs: Record<string, TurnWorkLog>
  /** sessionId → 上一次手动停止的回合快照（展示在消息列尾部） */
  stoppedLogs: Record<string, TurnWorkLog>

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
  /** 当前回合开始时刻（工作卡耗时统计用） */
  let turnStartedAt = 0

  /** 结束当前回合流（中止 + 清空流状态）；markStopped 时把进行中的工具活动存为停止快照 */
  function endStream(markStopped = false): void {
    const { stream } = get()
    // 归档到回合自己标注的会话：用户中途切了会话，停止快照也不挂错
    const ownerSessionId = stream.sessionId ?? get().activeSessionId
    if (markStopped && ownerSessionId && stream.tools.length > 0 && turnStartedAt > 0) {
      const stoppedLog: TurnWorkLog = {
        tools: stream.tools,
        durationMs: Date.now() - turnStartedAt,
        stopped: true
      }
      set((s) => ({ stoppedLogs: { ...s.stoppedLogs, [ownerSessionId]: stoppedLog } }))
    }
    turnStartedAt = 0
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
    workLogs: {},
    stoppedLogs: {},

    init: async () => {
      try{
        const current = await fetchCurrentUser()

        if(!current){
          //没登陆就不建立号，等登陆框提交后再init
          useUiStore.getState().setUsername(null)
          useUiStore.getState().openLogin()
          set({userId:null,sessions:[],initialized: true})
          return 
        }

        //已登录
        useUiStore.getState().setUsername(current.username)
        useUiStore.getState().closeLogin()
        set({userId:current.userId})

        const sessions = await fetchSessions(current.userId)
        set({sessions,initialized: true})
      }catch(error){
        console.error('[session] 初始化失败:', error)
        set({initialized:true})
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
        // 一并摘除该会话的内存快照，避免永久滞留
        // （停止快照按会话归档；工作卡按 assistant 消息 id 归档，消息删除后无从回看）
        const removedMessageIds = new Set((messages[id] ?? []).map((m) => m.id))
        delete messages[id]
        const stoppedLogs = { ...s.stoppedLogs }
        delete stoppedLogs[id]
        const workLogs = { ...s.workLogs }
        for (const messageId of removedMessageIds) {
          delete workLogs[messageId]
        }
        return {
          sessions,
          messages,
          stoppedLogs,
          workLogs,
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
      turnStartedAt = Date.now()

      set((s) => {
        // 新回合开始：清掉上一回合的停止快照
        const stoppedLogs = { ...s.stoppedLogs }
        delete stoppedLogs[sessionId]
        return {
          messages: {
            ...s.messages,
            [sessionId]: [...(s.messages[sessionId] ?? []), userMessage]
          },
          sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, updatedAt: Date.now() } : x)),
          stream: { streaming: true, sessionId, draft: { messageId: draftId, content: '' }, tools: [] },
          stoppedLogs
        }
      })

      abortTurn = startChatTurn({ userId, sessionId, content: trimmed }, (event) => {
        const state = get()
        const draft = state.stream.draft
        switch (event.type) {
          case 'delta':
            if (!draft) return
            // 说话打点：驱动引擎 speaking 状态（手势/点头），时间戳单调合并
            useLive2dSpeechStore.getState().markSpeaking()
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
          case 'gesture':
            useLive2dStore.getState().playGesture(event.gesture)
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
              stream: { streaming: false, tools: [] },
              // 回合正常结束：工具活动快照归档到该条 assistant 消息（工作卡可展开回看）
              workLogs: s.stream.tools.length
                ? {
                    ...s.workLogs,
                    [event.messageId]: {
                      tools: s.stream.tools,
                      durationMs: turnStartedAt > 0 ? Date.now() - turnStartedAt : 0,
                      stopped: false
                    }
                  }
                : s.workLogs
            }))
            turnStartedAt = 0
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
      endStream(true)
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
