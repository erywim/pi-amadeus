import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { SPEAKING_LIP_THRESHOLD } from './lib/live2d-engine'
import { POKE_PERFORMANCES, randomPerformance, type Performance } from './lib/performances'

/** 能演小表演的引擎接口（引擎的 perform 方法；老接口只有 gesture） */
interface PerformanceTarget {
  perform?: (performance: Performance) => boolean
  gesture?: (name: string) => boolean
}

/**
 * 戳她一下：随机演一段「表情 × 动作」——只做动作不换脸会显得面无表情。
 * 说话或语音回合进行中不打断；返回是否做出了反应。
 */
export function poke(engine: PerformanceTarget | null | undefined): boolean {
  const speech = useLive2dSpeechStore.getState()
  const speakingNow = performance.now() < speech.speakingUntil || speech.lipSyncValue > SPEAKING_LIP_THRESHOLD
  if (speech.voiceActive || speakingNow) return false
  const perf = randomPerformance(POKE_PERFORMANCES)
  const performed = engine?.perform?.(perf)
  if (performed !== undefined) return performed
  return perf.gesture ? (engine?.gesture?.(perf.gesture) ?? false) : false
}
