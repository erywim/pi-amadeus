import { create } from 'zustand'

/**
 * Live2D 说话状态。高频打点，刻意不走 persist 中间件
 * （persist 每次 set 都序列化写 localStorage）。
 *
 * 语音回合与文本流两路可能并存，所以：
 * - speakingUntil 用单调 max 合并——谁后说话谁生效，互不覆盖，
 *   结束靠时间戳超时自然收敛，不存在"一路结束把另一路关掉"的问题
 * - voiceActive 只由语音链路写；文本流用 sessionStore.stream.streaming，
 *   engine 侧做 OR 得到"回合进行中"
 */
interface Live2dSpeechState {
  /** 说话活动截止时间戳（performance.now 域）。engine 每帧比较 now < speakingUntil */
  speakingUntil: number
  /** 语音回合进行中（SSE 已发起、未 done/error/停止） */
  voiceActive: boolean
  /** 口型开合值 0..1：ttsPlayer 用 AnalyserNode 实时 RMS 每帧写入 */
  lipSyncValue: number

  markSpeaking: (ms?: number) => void
  setVoiceActive: (active: boolean) => void
  setLipSyncValue: (value: number) => void
}

export const useLive2dSpeechStore = create<Live2dSpeechState>()((set) => ({
  speakingUntil: 0,
  voiceActive: false,
  lipSyncValue: 0,

  markSpeaking: (ms = 1200) =>
    set((s) => ({ speakingUntil: Math.max(s.speakingUntil, performance.now() + ms) })),
  setVoiceActive: (voiceActive) => set({ voiceActive }),
  setLipSyncValue: (lipSyncValue) => set({ lipSyncValue })
}))
