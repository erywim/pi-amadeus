import * as ort from 'onnxruntime-web'

/**
 * 浏览器端 silero VAD（onnxruntime-web，WASM CPU 后端）。
 * 麦克风 16kHz 单声道 Float32 流 → 512 样本/帧推理 → 概率状态机
 * （正阈值 0.5 起 / 负阈值 0.35 止 + 8 帧赎回 + 3 帧最小语音），
 * 输出完整语音片段（含 1 帧前填充）。
 */

// ORT wasm 与加载器来自 public/ort/（dev 由 vite 静态服务；生产随包）。
// 注意：不能以 import.meta.env.BASE_URL（dev 为 '/'）作 URL base，会抛 Invalid base URL
ort.env.wasm.wasmPaths = new URL('../ort/', window.location.href).toString()
ort.env.wasm.numThreads = 1

const FRAME_SAMPLES = 512
const SAMPLE_RATE = 16000

const POSITIVE_THRESHOLD = 0.5
const NEGATIVE_THRESHOLD = 0.35
const PRE_PAD_FRAMES = 1
const REDEMPTION_FRAMES = 8
const MIN_SPEECH_FRAMES = 3
const MIN_SEGMENT_SECONDS = 0.3

export interface SpeechSegment {
  /** 16kHz 单声道 Float32 采样 */
  samples: Float32Array
  /** 起始时间（相对录音开始的 ms） */
  startMs: number
  /** 结束时间 ms */
  endMs: number
}

interface VadSession {
  run: (input: Float32Array) => Promise<number>
  /** 新一段录音开始前清零 LSTM 隐状态 */
  reset: () => void
}

let sessionPromise: Promise<VadSession> | null = null

// silero_vad.onnx（v5 LSTM）四输入：input[1,512] float32 + sr int64 + h/c 隐状态 [2,1,64]
const STATE_SHAPE = [2, 1, 64]
const STATE_SIZE = 128

async function loadSession(): Promise<VadSession> {
  const modelUrl = new URL('../models/silero_vad.onnx', window.location.href).toString()
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
  const inputName = session.inputNames[0] ?? 'input'
  const sr = new ort.Tensor('int64', [16000n])
  let h = new Float32Array(STATE_SIZE)
  let c = new Float32Array(STATE_SIZE)
  return {
    run: async (input) => {
      const results = await session.run({
        [inputName]: new ort.Tensor('float32', input, [1, input.length]),
        sr,
        h: new ort.Tensor('float32', h, STATE_SHAPE),
        c: new ort.Tensor('float32', c, STATE_SHAPE)
      })
      const hn = results.hn
      const cn = results.cn
      if (hn) h = new Float32Array(hn.data as Float32Array)
      if (cn) c = new Float32Array(cn.data as Float32Array)
      const output = results.output ?? Object.values(results)[0]
      if (!output) return 0
      const prob = (output.data as Float32Array)[0]
      return prob ?? 0
    },
    reset: () => {
      h = new Float32Array(STATE_SIZE)
      c = new Float32Array(STATE_SIZE)
    }
  }
}

export function getVadSession(): Promise<VadSession> {
  if (!sessionPromise) {
    // 失败不缓存：下次调用重试（模型文件缺失等临时问题可恢复）
    sessionPromise = loadSession().catch((error) => {
      sessionPromise = null
      throw error
    })
  }
  return sessionPromise
}

/**
 * 增量 VAD 状态机：喂入连续 512 样本帧，语音段结束时回调。
 * 使用说明：一个录音会话创建一个实例，喂完所有帧后调用 flush() 收尾。
 */
export class VadProcessor {
  private vad: VadSession
  private speaking = false
  private redemption = 0
  private speechFrames = 0
  /** 语音段缓冲（含前填充帧） */
  private segment: Float32Array[] = []
  private segmentStartMs: number | null = null
  /** 语音前滚动缓冲（静音帧也保留最近 N 帧作为前填充） */
  private prePad: Float32Array[] = []
  private frameIndex = 0

  private onSegment: (segment: SpeechSegment) => void

  constructor(onSegment: (segment: SpeechSegment) => void) {
    // 模型就绪前占位：全按语音处理（避免加载期丢内容，等价于整段兜底）
    this.vad = { run: async () => 1, reset: () => {} }
    this.onSegment = onSegment
    void this.init()
  }

  private async init(): Promise<void> {
    try {
      this.vad = await getVadSession()
      // 新录音开始：清零 LSTM 隐状态，避免上一段的残留状态影响首帧
      this.vad.reset()
    } catch (error) {
      console.error('[vad] silero 模型加载失败：', error)
      // 占位逻辑保留：无语音检测，整段作为输入
    }
  }

  /** 喂入一段 16kHz 单声道 Float32（内部按 512 切帧） */
  async feed(samples: Float32Array): Promise<void> {
    for (let offset = 0; offset + FRAME_SAMPLES <= samples.length; offset += FRAME_SAMPLES) {
      const frame = samples.subarray(offset, offset + FRAME_SAMPLES)
      await this.handleFrame(frame)
      this.frameIndex++
    }
  }

  private async handleFrame(frame: Float32Array): Promise<void> {
    let prob: number
    try {
      prob = await this.vad.run(frame)
    } catch {
      prob = 1 // 推理失败按语音处理，避免丢内容
    }
    this.step(prob, frame)
  }

  private step(prob: number, frame: Float32Array): void {
    const frameMsPerFrame = (FRAME_SAMPLES * 1000) / SAMPLE_RATE
    const frameMs = this.frameIndex * frameMsPerFrame

    if (!this.speaking) {
      if (prob >= POSITIVE_THRESHOLD) {
        this.speaking = true
        this.redemption = 0
        this.speechFrames = 1
        this.segment = [...this.prePad, frame.slice()]
        this.segmentStartMs = frameMs - this.prePad.length * frameMsPerFrame
        this.prePad = []
      } else {
        this.prePad.push(frame.slice())
        while (this.prePad.length > PRE_PAD_FRAMES) this.prePad.shift()
      }
      return
    }

    this.speechFrames++
    this.segment.push(frame.slice())

    if (prob < NEGATIVE_THRESHOLD) {
      this.redemption++
      if (this.redemption >= REDEMPTION_FRAMES) {
        this.endSegment(frameMs + frameMsPerFrame)
      }
    } else {
      this.redemption = 0
    }
  }

  private endSegment(endMs: number): void {
    const speechDurationFrames = this.segment.length
    this.speaking = false
    this.redemption = 0
    this.speechFrames = 0
    const segment = this.segment
    const startMs = this.segmentStartMs ?? 0
    this.segment = []
    this.segmentStartMs = null

    if (speechDurationFrames < MIN_SPEECH_FRAMES) return
    const total = segment.reduce((acc, f) => acc + f.length, 0)
    const samples = new Float32Array(total)
    let offset = 0
    for (const f of segment) {
      samples.set(f, offset)
      offset += f.length
    }
    const durationSec = total / SAMPLE_RATE
    if (durationSec < MIN_SEGMENT_SECONDS) return
    this.onSegment({ samples, startMs, endMs })
  }

  /** 录音结束时收尾：说话中则强制结束当前段 */
  flush(): void {
    if (this.speaking) {
      this.endSegment((this.frameIndex * FRAME_SAMPLES * 1000) / SAMPLE_RATE)
    }
  }
}
