import { create } from 'zustand'

/**
 * 陪伴模式对话流状态（不持久化）。
 * 语音回合的用户消息在服务端落库前，先用 pendingUser 乐观渲染气泡；
 * 服务端 messages 追到该条后自动清除（见 CompanionThread）。
 */
interface CompanionState {
  /** 语音回合已发出但尚未入库的用户消息（乐观气泡） */
  pendingUserText: string | null
  /** 舞台点击反馈的"吐槽"临时代替状态文案（时钟戳驱动过期） */
  tapNoticeUntil: number
  /** 首次发言后收起快速话题 */
  quickTopicsDismissed: boolean

  setPendingUser: (text: string | null) => void
  /** 点红莉栖：临时状态文案持续 1.6s */
  pokeNotice: () => void
  dismissQuickTopics: () => void
}

export const useCompanionStore = create<CompanionState>()((set) => ({
  pendingUserText: null,
  tapNoticeUntil: 0,
  quickTopicsDismissed: false,

  setPendingUser: (pendingUserText) => set({ pendingUserText }),
  pokeNotice: () => set({ tapNoticeUntil: Date.now() + 1600 }),
  dismissQuickTopics: () => set({ quickTopicsDismissed: true })
}))
