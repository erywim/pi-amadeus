import toast from 'react-hot-toast'
import { BRAIN_URL, startVoiceTurn } from './api'
import { VadProcessor, type SpeechSegment } from './vad'
import { enqueuePcm, stopTtsPlayback } from './ttsPlayer'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/**
 * 语音链路编排：
 * - 调试输入/STT 文本 → /api/voice SSE → 中文 delta 上对话框、情感驱动表情、
 *   base64 PCM 入 TTS 播放队列（口型联动）
 * - 麦克风（16kHz 单声道）→ 浏览器 silero VAD 切段 → /api/stt 转写 → 同上
 */

// ---------- 语音回合（LLM 回复 + TTS） ----------

let voiceAbort: AbortController | null = null

/** 发起一轮语音回合：返回是否成功发起 */
export function startAssistantVoiceTurn(text: string): boolean {
  const { userId, stream } = useSessionStore.getState()
  if (!userId || stream.streaming) return false
  const sessionId = useSessionStore.getState().ensureActiveSession()

  voiceAbort?.abort()
  // 新回合打断当前 TTS 队列（用户重新说话即打断，5.3 要求）
  stopTtsPlayback()
  useUiStore.getState().setDialogText('')
  useLive2dSpeechStore.getState().setLipSyncValue(0)

  voiceAbort = startVoiceTurn({ userId, sessionId, text }, (event) => {
    switch (event.type) {
      case 'delta':
        useUiStore.getState().setDialogText(
          (useUiStore.getState().dialogText ?? '') + event.delta
        )
        return
      case 'emotion':
        useLive2dStore.getState().setEmotion(event.emotion)
        return
      case 'gesture':
        useLive2dStore.getState().playGesture(event.gesture)
        return
      case 'audio':
        // 说话打点：驱动引擎 speaking 状态（手势/点头），时间戳单调合并
        useLive2dSpeechStore.getState().markSpeaking()
        enqueuePcm(event.data, event.sampleRate)
        return
      case 'done': {
        voiceAbort = null
        useLive2dSpeechStore.getState().setVoiceActive(false)
        void useSessionStore.getState().refreshSession(sessionId)
        return
      }
      case 'error':
        voiceAbort = null
        useLive2dSpeechStore.getState().setVoiceActive(false)
        console.warn('[voice] 回合出错：', event.message)
        toast.error('呜……大脑好像短路了，等会儿再试吧')
        return
      case 'transcript':
        return
    }
  })
  useLive2dSpeechStore.getState().setVoiceActive(true)
  return true
}

/** 停止当前语音回合（中止 SSE + 停止 TTS 播放） */
export function stopAssistantVoiceTurn(): void {
  voiceAbort?.abort()
  voiceAbort = null
  stopTtsPlayback()
  useLive2dSpeechStore.getState().setVoiceActive(false)
}

// ---------- 麦克风：VAD 切段 → STT ----------

const RECORD_SAMPLE_RATE = 16000

let micStream: MediaStream | null = null
let micContext: AudioContext | null = null
let micProcessor: ScriptProcessorNode | null = null
let vad: VadProcessor | null = null
let segmentBusy = false

/** 把 Float32 采样编码为 16bit 单声道 WAV（blob→base64 交给 /api/stt） */
function floatToWavBase64(samples: Float32Array, sampleRate: number): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function transcribeSegment(segment: SpeechSegment): Promise<string | null> {
  const wav = floatToWavBase64(segment.samples, RECORD_SAMPLE_RATE)
  try {
    const res = await fetch(`${BRAIN_URL}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcmBase64: wav, sampleRate: RECORD_SAMPLE_RATE })
    })
    if (!res.ok) throw new Error(`STT ${res.status}`)
    const json = (await res.json()) as { text?: string }
    const text = (json.text ?? '').trim()
    return text || null
  } catch (error) {
    console.warn('[voice] STT 失败：', error)
    toast.error('没听清呢，再说一次？')
    return null
  }
}

async function handleSegment(segment: SpeechSegment): Promise<void> {
  if (segmentBusy) return
  segmentBusy = true
  try {
    const text = await transcribeSegment(segment)
    if (text) {
      useUiStore.getState().setDialogText(`你说：${text}`)
      startAssistantVoiceTurn(text)
    }
  } finally {
    segmentBusy = false
  }
}

export async function startMic(): Promise<void> {
  if (micStream) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    micStream = stream
    const context = new AudioContext({ sampleRate: RECORD_SAMPLE_RATE })
    micContext = context
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(2048, 1, 1)
    micProcessor = processor
    vad = new VadProcessor((segment) => {
      void handleSegment(segment)
    })
    source.connect(processor)
    // 静音 gain 保活 processor（不把麦克风回放给扬声器）
    const mute = context.createGain()
    mute.gain.value = 0
    processor.connect(mute)
    mute.connect(context.destination)
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      void vad?.feed(new Float32Array(input))
    }
  } catch (error) {
    console.warn('[voice] 麦克风开启失败：', error)
    toast.error('麦克风不可用，检查系统权限')
    throw error
  }
}

export function stopMic(): void {
  vad?.flush()
  vad = null
  if (micProcessor) {
    micProcessor.disconnect()
    micProcessor.onaudioprocess = null
    micProcessor = null
  }
  if (micContext) {
    void micContext.close()
    micContext = null
  }
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop()
    micStream = null
  }
}

export function isMicActive(): boolean {
  return micStream !== null
}
