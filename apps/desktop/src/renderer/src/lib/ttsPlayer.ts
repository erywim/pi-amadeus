import { useLive2dStore } from '@renderer/stores/live2dStore'

/**
 * TTS PCM 播放器：把 /api/voice SSE 的 base64 PCM16 单声道块转成
 * AudioBuffer 顺序调度播放（块到达顺序 = 播放顺序），并用 AnalyserNode
 * 实时幅度驱动 Live2D 口型（lipSyncValue）。
 */

const LIP_SYNC_GAIN = 1.6

let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let scheduledUntil = 0
let rafId: number | null = null
let samplesBuf: Float32Array<ArrayBuffer> | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.55
    analyser.connect(audioCtx.destination)
    samplesBuf = new Float32Array(analyser.fftSize)
    // 输出走 analyser（幅度监测）→ destination；静音 gain 由块内容天然为零
  }
  return audioCtx
}

/** 口型驱动循环：读 analyser 实时幅度 → lipSyncValue（空闲时归零） */
function startLipSyncLoop(): void {
  if (rafId !== null) return
  const tick = (): void => {
    const ctx = audioCtx
    const node = analyser
    if (!ctx || !node || !samplesBuf) return
    node.getFloatTimeDomainData(samplesBuf)
    let sum = 0
    for (let i = 0; i < samplesBuf.length; i++) sum += samplesBuf[i]! * samplesBuf[i]!
    const rms = Math.sqrt(sum / samplesBuf.length)
    // 播放结束（调度时间耗尽且缓冲区基本静音）→ 口型归零
    if (ctx.currentTime > scheduledUntil + 0.1 && rms < 0.004) {
      useLive2dStore.getState().setLipSyncValue(0)
      rafId = null
      return
    }
    useLive2dStore.getState().setLipSyncValue(Math.min(1, rms * LIP_SYNC_GAIN))
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
}

/** 跨块 carry：SSE 音频块可能按任意字节边界切分（16bit PCM 奇数长度） */
let carry: number | null = null

/** 入队一段 base64 PCM16（s16le）并顺序播放 */
export function enqueuePcm(base64: string, sampleRate: number): void {
  const ctx = getAudioContext()
  const raw = atob(base64)
  let bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  // 上一块的奇数尾字节先拼进来，本块新产生的尾字节留到下一块
  if (carry !== null) {
    const joined = new Uint8Array(bytes.length + 1)
    joined[0] = carry
    joined.set(bytes, 1)
    bytes = joined
    carry = null
  }
  if (bytes.length % 2 !== 0) {
    carry = bytes[bytes.length - 1]!
    bytes = bytes.subarray(0, bytes.length - 1)
  }
  if (bytes.length === 0) return
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
  const samples = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) samples[i] = int16[i]! / 32768

  const buffer = ctx.createBuffer(1, samples.length, sampleRate)
  buffer.copyToChannel(samples, 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  // 单一路径：source → analyser（幅度监测）→ destination
  source.connect(analyser!)

  const startAt = Math.max(ctx.currentTime + 0.02, scheduledUntil)
  source.start(startAt)
  scheduledUntil = startAt + buffer.duration
  startLipSyncLoop()
}

/** 全部停止（中途打断语音回合时） */
export function stopTtsPlayback(): void {
  carry = null
  scheduledUntil = audioCtx?.currentTime ?? 0
  if (audioCtx) {
    void audioCtx.close()
    audioCtx = null
    analyser = null
    samplesBuf = null
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  useLive2dStore.getState().setLipSyncValue(0)
}
