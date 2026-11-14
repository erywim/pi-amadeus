import { create } from 'zustand'
import type {
  AttachmentKind,
  Message,
  MessageAttachment,
  Session,
  SessionMessages,
  SseEvent,
  StreamState,
  WorldlineInfo,
  ToolActivityItem,
  ToolStatus
} from '@pi-amadeus/shared'
import {
  confirmTool,
  deleteSessionApi,
  fetchCurrentUser,
  fetchMessages,
  fetchSessions,
  jumpWorldline,
  renameSessionApi,
  setSessionArchivedApi,
  setSessionPinnedApi,
  startChatTurn,
  switchBranchApi,
  startEditTurn,
  startRegenerate
} from '@renderer/lib/api'
import { useLive2dStore } from './live2dStore'
import { useLive2dSpeechStore } from './live2dSpeechStore'
import { useMemoryStore } from './memoryStore'
import { useSettingsStore } from './settingsStore'
import { useUiStore } from './uiStore'

/**
 * 回合工作过程日志：一个回合的工具活动快照 + 耗时（紧凑工作台风格折叠卡的数据源）。
 * 不落库、仅内存：本会话窗口内可回看，重进页面后历史消息不带工作卡。
 */
/** 输入区待发送的附件（base64 在内存里，发送后才落盘） */
export interface OutgoingAttachment {
  name: string
  mimeType: string
  size: number
  /** base64，不含 data: 前缀 */
  data: string
  /** 本地预览（图片用 data URL，其它为空） */
  previewUrl?: string
}

function attachmentKind(mimeType: string, name: string): AttachmentKind {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return 'image'
  if (/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(name)) return 'audio'
  return 'file'
}

export interface TurnWorkLog {
  tools: ToolActivityItem[]
  durationMs: number
  /** 被手动停止（发送键变停止键时点击）的回合 */
  stopped: boolean
}

/** 流式进行中用户继续发送的消息：排队，本回合正常结束后自动发出下一条 */
export interface QueuedTurn {
  id: string
  text: string
  attachments: OutgoingAttachment[]
  createdAt: number
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
  /** sessionId → 当前活动世界线（序号 / 总数 / 变动率 / 是否回退中） */
  worldlines: Record<string, WorldlineInfo>
  activeSessionId: string | null
  stream: SessionStreamState
  userId: string | null
  /** 启动初始化是否完成（失败也置 true，避免反复重试） */
  initialized: boolean
  /** assistant 消息 id → 工作过程日志（回合正常结束时写入） */
  workLogs: Record<string, TurnWorkLog>
  /** sessionId → 上一次手动停止的回合快照（展示在消息列尾部） */
  stoppedLogs: Record<string, TurnWorkLog>
  /**
   * sessionId → 最近一次回合失败的错误信息。
   * 失败要留在消息列里让用户看见（含重试入口），不能只打 console；
   * 下一次发起回合或手动关闭时清掉。
   */
  turnErrors: Record<string, string>
  /** sessionId → 排队中的消息（流式期间发送不会丢，也不会并发跑两个回合） */
  queued: Record<string, QueuedTurn[]>

  init: () => Promise<void>
  refreshSessions: () => Promise<void>
  refreshSession: (sessionId: string) => Promise<void>
  selectSession: (id: string) => void
  createSession: () => string
  /** 返回当前选中会话；无则新建（语音回合复用文本会话） */
  ensureActiveSession: () => string
  deleteSession: (id: string) => void
  sendMessage: (text: string, attachments?: OutgoingAttachment[]) => void
  /** 重新生成最后一条回复（会话末尾是用户消息时等于重试失败的回合） */
  regenerate: () => void
  /** 编辑用户消息并重发：服务端截断后续消息，本地同步截断后追加新回复 */
  editMessage: (messageId: string, content: string) => void
  /** 置顶 / 取消置顶（乐观更新；失败回滚） */
  togglePin: (id: string) => Promise<void>
  /** 归档 / 取消归档（乐观更新；失败回滚） */
  toggleArchive: (id: string) => Promise<void>
  /** 消息分支切换：-1 上一个分支 / 1 下一个分支 */
  switchBranch: (messageId: string, direction: -1 | 1) => Promise<void>
  /** 世界线跳跃：切到目标消息所在分支的最新叶子 */
  switchSibling: (messageId: string, direction: -1 | 1) => void
  /** 回退到某条消息，下一条消息将从这里分叉 */
  rewindTo: (messageId: string) => void
  /** 从世界线面板跳到某个叶子 */
  jumpToWorldline: (leafId: string) => void
  stopStreaming: () => void
  /** bash 确认卡应答（允许/拒绝） */
  respondToolConfirm: (approved: boolean) => void
  /** 手动重命名（乐观更新；失败回滚并抛出，由调用方提示） */
  renameSession: (id: string, title: string) => Promise<void>
  dismissTurnError: (sessionId: string) => void
  /** 移除一条排队消息 */
  removeQueued: (sessionId: string, queuedId: string) => void
  /** 清空某会话的排队消息 */
  clearQueued: (sessionId: string) => void
  /** 手动发出排队中的下一条（停止/失败后由用户决定是否继续） */
  flushQueue: (sessionId: string) => void
}

export const useSessionStore = create<SessionState>()((set, get) => {
  let abortTurn: AbortController | null = null
  /** 当前回合开始时刻（工作卡耗时统计用） */
  let turnStartedAt = 0

  /** 在指定会话上真正发起一个回合（普通发送与排队发送共用） */
  function startTurn(sessionId: string, text: string, outgoing: OutgoingAttachment[] = []): void {
    const { stream, userId } = get()
    if (stream.streaming || !userId) return

    const trimmed = text.trim()
    if (!trimmed && outgoing.length === 0) return

    const now = Date.now()
    const localAttachments: MessageAttachment[] = outgoing.map((item, index) => ({
      id: `local-${now}-${index}`,
      kind: attachmentKind(item.mimeType, item.name),
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      url: item.previewUrl ?? ''
    }))
    const userMessage: Message = {
      id: `local-${now}-u`,
      sessionId,
      role: 'user',
      content: trimmed,
      ttsText: null,
      mode: 'text',
      attachments: localAttachments,
      createdAt: now
    }
    const draftId = `local-${now}-a`
    turnStartedAt = Date.now()

    set((s) => {
      // 新回合开始：清掉上一回合的停止快照与错误卡
      const stoppedLogs = { ...s.stoppedLogs }
      delete stoppedLogs[sessionId]
      const turnErrors = { ...s.turnErrors }
      delete turnErrors[sessionId]
      return {
        messages: {
          ...s.messages,
          [sessionId]: [...(s.messages[sessionId] ?? []), userMessage]
        },
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, updatedAt: Date.now() } : x)),
        stream: { streaming: true, sessionId, draft: { messageId: draftId, content: '' }, tools: [] },
        stoppedLogs,
        turnErrors
      }
    })

    abortTurn = startChatTurn(
      {
        userId,
        sessionId,
        content: trimmed,
        attachments: outgoing.map((item) => ({
          name: item.name,
          mimeType: item.mimeType,
          data: item.data
        }))
      },
      (event) => {
        handleTurnEvent(sessionId, event, false)
      }
    )
  }

  /** 回合完成且窗口不在前台时发系统通知（权限未授予则静默跳过） */
  function notifyTurnDone(sessionId: string, content: string): void {
    const settings = useSettingsStore.getState()
    // hasFocus 比 document.hidden 更准确：Electron 窗口失焦但仍可见时 hidden 为 false
    if (!settings.notifyOnComplete || document.hasFocus()) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const title = get().sessions.find((session) => session.id === sessionId)?.title || 'Amadeus'
    try {
      const notification = new Notification(title, {
        body: content.replace(/\s+/g, ' ').trim().slice(0, 120)
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
    } catch (error) {
      console.warn('[session] 系统通知发送失败：', error)
    }
  }

  /** 自动推进队列：优先刚结束的会话，其次当前会话 */
  function flushNextQueued(preferredSessionId?: string): void {
    if (get().stream.streaming) return
    const { queued, activeSessionId } = get()
    const candidates = [preferredSessionId, activeSessionId].filter(
      (id): id is string => typeof id === 'string'
    )
    for (const sessionId of candidates) {
      if ((queued[sessionId]?.length ?? 0) === 0) continue
      get().flushQueue(sessionId)
      return
    }
  }

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
    // 停止/失败都不会收到 done 事件，本地用户消息仍是 local-… 临时 id；
    // 从服务端回读一次、只把 id 对齐到落库值（不覆盖本地消息列，避免把用户
    // 刚发出的下一条消息冲掉），否则紧接着「编辑后重发」会 404。
    if (ownerSessionId) {
      const sessionId = ownerSessionId
      void fetchMessages(sessionId)
        .then((page) => {
          const serverMessages = page.messages
          set((s) => {
            // 新一轮已经开始：这次回读的旧快照不能碰当前消息列
            if (s.stream.streaming && s.stream.sessionId === sessionId) return {}
            const local = s.messages[sessionId] ?? []
            const next = local.map((message, index) => {
              const counterpart = serverMessages[index]
              return counterpart &&
                counterpart.role === message.role &&
                counterpart.content === message.content
                ? { ...message, id: counterpart.id }
                : message
            })
            return { messages: { ...s.messages, [sessionId]: next } }
          })
        })
        .catch((error) => console.warn('[session] 消息 id 对齐失败：', error))
    }
  }

  /**
   * 回合 SSE 事件 → store 状态。普通发送与重新生成共用同一套消费逻辑：
   * replaceLast=true（重新生成）时，done 用新回复替换消息列末尾的旧助手消息；
   * false（普通回合）时追加。错误一律落到 turnErrors，由消息列的错误卡展示。
   */
  function handleTurnEvent(sessionId: string, event: SseEvent, replaceLast: boolean): void {
    const draft = get().stream.draft
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
      case 'thinking':
        if (!draft) return
        // 思考增量单独累积到 draft.thinking：折叠区展示，不混进正文
        set((s) => ({
          stream: {
            ...s.stream,
            streaming: true,
            draft: { ...draft, thinking: (draft.thinking ?? '') + event.delta }
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
          ...(finalDraft.thinking ? { thinking: finalDraft.thinking } : {}),
          createdAt: Date.now()
        }
        set((s) => {
          const prev = s.messages[sessionId] ?? []
          // 重新生成：服务端已替换旧回复，本地同步摘掉末尾那条旧助手消息，
          // 否则界面会留下「旧回答 + 新回答」两条
          const base = replaceLast && prev.at(-1)?.role === 'assistant' ? prev.slice(0, -1) : prev
          // 发送时插入的用户消息是本地临时 id（local-…）；服务端把落库后的 id 带回来，
          // 这里替换掉，之后「编辑后重发」才能按真实 id 定位
          const withServerIds = event.userMessageId
            ? base.map((message, index) =>
                index === base.length - 1 && message.role === 'user'
                  ? { ...message, id: event.userMessageId! }
                  : message
              )
            : base
          return {
            messages: {
              ...s.messages,
              [sessionId]: [...withServerIds, assistantMessage]
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
          }
        })
        turnStartedAt = 0
        abortTurn = null
        notifyTurnDone(sessionId, assistantMessage.content)
        // 正常结束后自动发下一条排队消息（停止/失败不自动继续，交给用户决定）
        flushNextQueued(sessionId)
        // 回合结束后回读一次：同步服务端消息 id、分支序号与附件 URL
        void get().refreshSession(sessionId)
        // 标题是服务端首轮后异步生成的：静默刷新列表拿标题/消息数
        void get().refreshSessions()
        // 拉一次服务端权威页面：本地追加的消息没有 parentId / siblingIds，
        // 只有服务端的活动世界线才知道这次回复是不是分叉（标题栏与箭头要用）
        void get().refreshSession(sessionId)
        // 回合结束后好感度会变：刷新侧栏的关系读数（服务端按真实事件累计）
        const { userId } = get()
        if (userId) void useMemoryStore.getState().refreshAffinity(userId)
        return
      }
      case 'error':
        console.warn('[session] 回合出错：', event.message)
        // 失败先落错误信息再清流：错误卡挂在产生它的会话上，切走再回来仍在
        set((s) => ({ turnErrors: { ...s.turnErrors, [sessionId]: event.message } }))
        endStream()
        return
      case 'audio':
      case 'transcript':
        return
    }
  }

  /** 把服务端返回的世界线页面写进缓存（消息 + 世界线元信息） */
  function applyPage(sessionId: string, page: SessionMessages): void {
    set((s) => ({
      messages: { ...s.messages, [sessionId]: page.messages },
      worldlines: { ...s.worldlines, [sessionId]: page.worldline }
    }))
  }

  /**
   * 世界线跳跃（异步）：成功后整体替换页面。
   * 跳线后旧世界线的错误卡与停止快照不再适用，一并清掉——否则用户会在
   * 另一条世界线上看到上一段分支的报错，误以为是当前这段出了问题。
   */
  async function jump(sessionId: string, messageId: string, toLeaf: boolean): Promise<void> {
    const page = await jumpWorldline(sessionId, messageId, toLeaf)
    applyPage(sessionId, page)
    set((s) => {
      const turnErrors = { ...s.turnErrors }
      delete turnErrors[sessionId]
      const stoppedLogs = { ...s.stoppedLogs }
      delete stoppedLogs[sessionId]
      return { turnErrors, stoppedLogs }
    })
  }

  return {
    sessions: [],
    messages: {},
    worldlines: {},
    activeSessionId: null,
    stream: { streaming: false, tools: [] },
    userId: null,
    initialized: false,
    workLogs: {},
    stoppedLogs: {},
    turnErrors: {},
    queued: {},

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
        const page = await fetchMessages(sessionId)
        // 回读期间用户已经发了新回合：旧快照不能覆盖正在流式的消息列
        const stream = get().stream
        if (stream.streaming && stream.sessionId === sessionId) return
        applyPage(sessionId, page)
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
        pinned: false,
        archived: false,
        messageCount: 0,
        localOnly: true
      }
      set((s) => ({
        sessions: [session, ...s.sessions],
        messages: { ...s.messages, [id]: [] },
        worldlines: {
          ...s.worldlines,
          [id]: { headId: null, index: 0, total: 0, divergence: 1, rewound: false }
        },
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
        const turnErrors = { ...s.turnErrors }
        delete turnErrors[id]
        const workLogs = { ...s.workLogs }
        for (const messageId of removedMessageIds) {
          delete workLogs[messageId]
        }
        const queued = { ...s.queued }
        delete queued[id]
        const worldlines = { ...s.worldlines }
        delete worldlines[id]
        return {
          sessions,
          messages,
          worldlines,
          stoppedLogs,
          workLogs,
          turnErrors,
          queued,
          activeSessionId: s.activeSessionId === id ? null : s.activeSessionId
        }
      })
    },

    sendMessage: (text, outgoing = []) => {
      const { activeSessionId, stream, userId } = get()
      if (!activeSessionId || !userId) return

      const trimmed = text.trim()
      if (!trimmed && outgoing.length === 0) return

      // 流式期间继续发送 → 排队（保持顺序，本回合结束后自动发下一条）
      if (stream.streaming) {
        const item: QueuedTurn = {
          id: crypto.randomUUID(),
          text: trimmed,
          attachments: outgoing,
          createdAt: Date.now()
        }
        set((s) => ({
          queued: {
            ...s.queued,
            [activeSessionId]: [...(s.queued[activeSessionId] ?? []), item]
          }
        }))
        return
      }

      startTurn(activeSessionId, trimmed, outgoing)
    },

    regenerate: () => {
      const { activeSessionId, stream, userId } = get()
      if (stream.streaming || !activeSessionId || !userId) return

      const sessionId = activeSessionId
      const draftId = `local-${Date.now()}-a`
      turnStartedAt = Date.now()

      // 重新生成不清消息列：新回复流出前旧回复仍在（服务端成功落库后才替换），
      // 失败时用户不会丢掉上一版答案；错误卡此时让位给新的流式内容
      set((s) => {
        const turnErrors = { ...s.turnErrors }
        delete turnErrors[sessionId]
        return {
          stream: { streaming: true, sessionId, draft: { messageId: draftId, content: '' }, tools: [] },
          turnErrors
        }
      })

      abortTurn = startRegenerate({ userId, sessionId }, (event) => {
        handleTurnEvent(sessionId, event, true)
      })
    },

    editMessage: (messageId, content) => {
      const { activeSessionId, stream, userId, messages } = get()
      if (stream.streaming || !activeSessionId || !userId) return
      const trimmed = content.trim()
      if (!trimmed) return
      const sessionId = activeSessionId
      const list = messages[sessionId] ?? []
      const index = list.findIndex((message) => message.id === messageId && message.role === 'user')
      if (index < 0) return
      const kept = list.slice(0, index + 1)
      const edited: Message = { ...kept[index]!, content: trimmed }
      const nextMessages = [...kept.slice(0, index), edited]
      const keptIds = new Set(nextMessages.map((message) => message.id))
      const draftId = `local-${Date.now()}-a`
      turnStartedAt = Date.now()

      // 本地与服务端同步截断：编辑点之后的旧分支立即从界面消失，
      // 新回复以普通回合追加（服务端同样先截断再跑）
      set((s) => ({
        messages: { ...s.messages, [sessionId]: nextMessages },
        stream: { streaming: true, sessionId, draft: { messageId: draftId, content: '' }, tools: [] },
        turnErrors: Object.fromEntries(
          Object.entries(s.turnErrors).filter(([key]) => key !== sessionId)
        ),
        stoppedLogs: Object.fromEntries(
          Object.entries(s.stoppedLogs).filter(([key]) => key !== sessionId)
        ),
        workLogs: Object.fromEntries(
          Object.entries(s.workLogs).filter(([key]) => keptIds.has(key))
        )
      }))

      abortTurn = startEditTurn({ userId, sessionId, messageId, content: trimmed }, (event) => {
        handleTurnEvent(sessionId, event, false)
      })
    },

    togglePin: async (id) => {
      const { userId, sessions } = get()
      if (!userId) return
      const prev = sessions.find((session) => session.id === id)?.pinned ?? false
      const next = !prev
      set((s) => ({
        sessions: s.sessions.map((session) =>
          session.id === id ? { ...session, pinned: next } : session
        )
      }))
      try {
        await setSessionPinnedApi(id, next, userId)
      } catch (error) {
        set((s) => ({
          sessions: s.sessions.map((session) =>
            session.id === id ? { ...session, pinned: prev } : session
          )
        }))
        throw error
      }
    },

    toggleArchive: async (id) => {
      const { userId, sessions } = get()
      if (!userId) return
      const prev = sessions.find((session) => session.id === id)?.archived ?? false
      const next = !prev
      set((s) => ({
        sessions: s.sessions.map((session) =>
          session.id === id ? { ...session, archived: next } : session
        )
      }))
      try {
        await setSessionArchivedApi(id, next, userId)
      } catch (error) {
        set((s) => ({
          sessions: s.sessions.map((session) =>
            session.id === id ? { ...session, archived: prev } : session
          )
        }))
        throw error
      }
    },

    switchBranch: async (messageId, direction) => {
      const { activeSessionId, userId, stream } = get()
      if (!activeSessionId || !userId || stream.streaming) return
      try {
        await switchBranchApi({ sessionId: activeSessionId, userId, messageId, direction })
        await get().refreshSession(activeSessionId)
      } catch (error) {
        console.warn('[session] 切换分支失败：', error)
        throw error
      }
    },

    switchSibling: (messageId, direction) => {
      const { activeSessionId, stream, messages } = get()
      if (!activeSessionId || stream.streaming) return
      const message = (messages[activeSessionId] ?? []).find((item) => item.id === messageId)
      const siblings = message?.siblingIds ?? []
      const index = siblings.indexOf(messageId)
      const next = index >= 0 ? siblings[index + direction] : undefined
      if (!next) return
      void jump(activeSessionId, next, true).catch((error) => console.warn('[session] 世界线跳转失败：', error))
    },

    rewindTo: (messageId) => {
      const { activeSessionId, stream } = get()
      if (!activeSessionId || stream.streaming) return
      void jump(activeSessionId, messageId, false).catch((error) => console.warn('[session] 回退失败：', error))
    },

    jumpToWorldline: (leafId) => {
      const { activeSessionId, stream } = get()
      if (!activeSessionId || stream.streaming) return
      void jump(activeSessionId, leafId, true).catch((error) => console.warn('[session] 世界线跳转失败：', error))
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
    },

    renameSession: async (id, title) => {
      const trimmed = title.trim()
      if (!trimmed) return
      const { userId } = get()
      if (!userId) return
      const prevTitle = get().sessions.find((x) => x.id === id)?.title ?? ''
      if (trimmed === prevTitle) return
      // 乐观更新：先上屏再落库；失败回滚到原标题，界面不能停留在服务端没接受的名字上
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: trimmed } : x))
      }))
      try {
        await renameSessionApi(id, trimmed, userId)
      } catch (error) {
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: prevTitle } : x))
        }))
        throw error
      }
    },

    dismissTurnError: (sessionId) => {
      set((s) => {
        const turnErrors = { ...s.turnErrors }
        delete turnErrors[sessionId]
        return { turnErrors }
      })
    },

    removeQueued: (sessionId, queuedId) => {
      set((s) => {
        const list = (s.queued[sessionId] ?? []).filter((item) => item.id !== queuedId)
        const queued = { ...s.queued }
        if (list.length > 0) queued[sessionId] = list
        else delete queued[sessionId]
        return { queued }
      })
    },

    clearQueued: (sessionId) => {
      set((s) => {
        const queued = { ...s.queued }
        delete queued[sessionId]
        return { queued }
      })
    },

    flushQueue: (sessionId) => {
      if (get().stream.streaming) return
      const list = get().queued[sessionId] ?? []
      const first = list[0]
      if (!first) return
      set((s) => {
        const next = (s.queued[sessionId] ?? []).slice(1)
        const queued = { ...s.queued }
        if (next.length > 0) queued[sessionId] = next
        else delete queued[sessionId]
        return { queued }
      })
      startTurn(sessionId, first.text, first.attachments)
    }
  }
})
