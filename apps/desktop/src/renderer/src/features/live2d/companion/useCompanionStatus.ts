import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { SPEAKING_LIP_THRESHOLD } from '../lib/live2d-engine'

export type CompanionStatus = 'idle' | 'listening' | 'thinking' | 'speaking'

/**
 * 陪伴模式状态胶囊的派生源：
 * 麦克风开着 → 倾听；嘴巴在动（TTS 口型幅度）→ 说话；
 * 语音回合进行中或文本回合流式 → 思考；否则待机。
 */
export function useCompanionStatus(): CompanionStatus {
  const micActive = useUiStore((s) => s.micActive)
  const voiceActive = useLive2dSpeechStore((s) => s.voiceActive)
  // boolean selector：60fps 的口型值只在跨阈值时触发重渲染
  const speaking = useLive2dSpeechStore((s) => s.lipSyncValue > SPEAKING_LIP_THRESHOLD)
  const textStreaming = useSessionStore((s) => s.stream.streaming)

  if (micActive) return 'listening'
  if (speaking) return 'speaking'
  if (voiceActive || textStreaming) return 'thinking'
  return 'idle'
}
