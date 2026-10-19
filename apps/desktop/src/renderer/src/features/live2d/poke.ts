import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { SPEAKING_LIP_THRESHOLD } from './lib/live2d-engine'

/** 戳一戳她的随机反应：傲娇池（陪伴页舞台与桌宠共用） */
const POKE_GESTURES = ['tilt', 'wink', 'hmph', 'startle', 'nod'] as const

/** 能播手势的引擎接口（引擎的 gesture 调试钩子） */
interface GestureTarget {
  gesture?: (name: string) => boolean
}

/** 戳她一下：说话或语音回合进行中不打断；返回是否做出了反应 */
export function poke(engine: GestureTarget | null | undefined): boolean {
  const speech = useLive2dSpeechStore.getState()
  const speakingNow = performance.now() < speech.speakingUntil || speech.lipSyncValue > SPEAKING_LIP_THRESHOLD
  if (speech.voiceActive || speakingNow) return false
  const gesture = POKE_GESTURES[Math.floor(Math.random() * POKE_GESTURES.length)]!
  return engine?.gesture?.(gesture) ?? false
}
