import * as PIXI from 'pixi.js'
// 必须从 /cubism4 子路径导入：包根入口（index.es.js）在模块顶层
// 无条件检查 window.Live2D（Cubism 2 运行时），缺省直接 throw。
// cubism4 构建只依赖 Live2DCubismCore，且兼容 Cubism 3 模型。
import { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4'
import type { Emotion } from '@pi-amadeus/shared'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { MotionLayer } from './motion-layer'
import { ProceduralLayer } from './procedural-layer'

// 模块级注册一次：此后 Live2DModel 的每帧 update 由 PIXI.Ticker.shared 驱动。
// 顺序契约：模型 update 在 Live2DModel.from() 时加入 shared ticker，
// 引擎 tick 在 load() 完成后才加入（同一 ticker、更晚注册）→
// 共享 ticker 按注册顺序回调，引擎写的参数是每帧最终值。
// 注意：tick 必须挂 shared 而不是 app.ticker（两者是独立的 RAF 循环，无顺序保证）。
Live2DModel.registerTicker(PIXI.Ticker)

const MODEL_DIR = 'live2dmodels/steinsGateKurisuNew/'
const MODEL_FILE = '红莉栖.model3.json'
// BASE_URL：dev 为 '/'，build 为 './'（file:// 下可用）
const MODEL_URL = `${import.meta.env.BASE_URL}${MODEL_DIR}${encodeURIComponent(MODEL_FILE)}`

// 情绪动作防抖窗口：SSE 情绪事件可能连发，合并后只播最后一个
const EMOTION_MOTION_DEBOUNCE_MS = 600
// speaking 判定阈值：lipSyncValue 高于此视为嘴在动（TTS 的自然延伸器）
const SPEAKING_LIP_THRESHOLD = 0.03

const RANDOM_MOTION_COUNT = 5

interface ModelSettingsJson {
  url?: string
  FileReferences?: unknown
  Groups?: unknown
  [key: string]: unknown
}

/** 引擎内部缓存的回合状态（getState 给 IdleScheduler 轮询用，避免重复计算） */
export interface TurnState {
  busy: boolean
  speaking: boolean
}

/**
 * Live2D 引擎单实例（每挂载一个）：PIXI Application + 模型加载 + 三层动画装配。
 * 分层：MotionLayer（动作，一遍即停）→ ProceduralLayer（程序表演，每帧最后写）。
 * 生命周期契约：
 * - destroy() 幂等、不删 canvas DOM（节点归 React）
 * - 迟到 Promise 靠 destroyed 标志静默丢弃（StrictMode 双挂载安全）
 * - 所有定时器/监听器在 destroy 中清理
 */
export class Live2DEngine {
  private app: PIXI.Application | null = null
  private model: Live2DModel | null = null
  private destroyed = false
  private unsubscribe: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null
  private motionLayer: MotionLayer | null = null
  private procedural: ProceduralLayer | null = null
  private emotionTimer: ReturnType<typeof setTimeout> | null = null
  private elapsed = 0
  // 光标：归一化 -1..1（窗口中心原点）+ 是否在窗口内
  private cursorX = 0
  private cursorY = 0
  private cursorInside = false
  private gazeImpulse = { x: 0, y: 0 }
  private state: TurnState = { busy: false, speaking: false }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement
  ) {}

  isDestroyed(): boolean {
    return this.destroyed
  }

  private get core(): {
    setParameterValueById(id: string, value: number): void
    getParameterValueById(id: string): number
  } | null {
    // coreModel 的声明类型是 CubismModel 联合（Cubism2/4），这里只取需要的方法
    return (this.model?.internalModel.coreModel as unknown) as {
      setParameterValueById(id: string, value: number): void
      getParameterValueById(id: string): number
    } | null
  }

  async load(): Promise<void> {
    const res = await fetch(MODEL_URL)
    if (this.destroyed) return
    if (!res.ok) throw new Error(`model3.json 加载失败: HTTP ${res.status}`)
    const json = (await res.json()) as ModelSettingsJson
    if (this.destroyed) return
    // settings.url 钉成绝对地址：moc3/贴图/physics/exp/motion 的相对路径都按它解析
    const settings = { ...json, url: MODEL_URL } as unknown as Parameters<typeof Live2DModel.from>[0]

    const app = new PIXI.Application({
      view: this.canvas,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      resizeTo: this.container,
      antialias: true
    })
    this.app = app

    const model = await Live2DModel.from(settings)
    if (this.destroyed) {
      // 迟到加载：挂载已卸载，清理后退出
      model.destroy()
      app.destroy(false)
      return
    }

    this.model = model
    model.interactive = false
    model.anchor.set(0.5, 0.5)
    app.stage.addChild(model)
    this.applyTransform()

    // 三层装配：动作层 + 程序层
    this.motionLayer = new MotionLayer(model)
    this.procedural = new ProceduralLayer(this.core!)
    this.setExpression(useLive2dStore.getState().emotion)

    // 挂 shared ticker（模型 update 之后注册 → 每帧晚于模型执行，参数写入为最终值）
    PIXI.Ticker.shared.add(this.tick)
    this.unsubscribe = useLive2dStore.subscribe((state, prev) => {
      if (this.destroyed || !this.model) return
      if (state.emotion !== prev.emotion) {
        // 表情与配套动作由同一事件触发：500ms 淡入（库内建）时长一致，天然同步
        this.setExpression(state.emotion)
        if (state.emotion !== 'neutral') this.scheduleEmotionMotion(state.emotion)
        // neutral 只切表情，不强行打断正在播的动作
      }
      if (state.avatar !== prev.avatar) this.applyTransform()
    })
    this.resizeObserver = new ResizeObserver(() => this.applyTransform())
    this.resizeObserver.observe(this.container)

    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('blur', this.onPointerLeave)

    window.__live2d = this
  }

  /** 每帧：状态机 → 程序层写参数（口型/眨眼/摆动/注视/复位） */
  private readonly tick = (deltaTime: number): void => {
    if (this.destroyed) return
    const core = this.core
    const procedural = this.procedural
    if (!core || !procedural) return
    // PIXI v6 Ticker deltaTime 是帧（60fps 基准）→ /60 转秒
    const dt = deltaTime / 60
    this.elapsed += dt

    this.state = this.computeState()
    const lipSyncValue = useLive2dStore.getState().lipSyncValue

    procedural.update(
      {
        dt,
        t: this.elapsed,
        busy: this.state.busy,
        speaking: this.state.speaking,
        lipTarget: lipSyncValue,
        gazeImpulse: this.gazeImpulse,
        cursor: { x: this.cursorX, y: this.cursorY, warm: this.cursorInside ? 1 : 0 }
      },
      core,
      this.motionLayer?.active?.ownedParams ?? null
    )
  }

  /** 回合状态：两路并存用 OR；speaking 由时间戳 + TTS 幅度双信号判定 */
  private computeState(): TurnState {
    const speech = useLive2dSpeechStore.getState()
    const streaming = useSessionStore.getState().stream.streaming
    const lipSyncValue = useLive2dStore.getState().lipSyncValue
    const now = performance.now()
    return {
      busy: speech.voiceActive || streaming,
      speaking: now < speech.speakingUntil || lipSyncValue > SPEAKING_LIP_THRESHOLD
    }
  }

  // —— 情绪联动 ——

  private scheduleEmotionMotion(emotion: Emotion): void {
    // Emotion 枚举即资产名（shared/emotion.ts：与 model3.json Expression 条目一一对应），
    // 同名动作组必然存在，无需映射
    if (this.emotionTimer) clearTimeout(this.emotionTimer)
    this.emotionTimer = setTimeout(() => {
      this.emotionTimer = null
      if (this.destroyed) return
      // FORCE 恒可打断：情绪切换是强事件，待机/手势让位
      void this.motionLayer?.play(emotion, 0, MotionPriority.FORCE, 1)
    }, EMOTION_MOTION_DEBOUNCE_MS)
  }

  setExpression(name: Emotion): void {
    if (!this.model) return
    try {
      this.model.expression(name)
    } catch {
      // 表情文件缺失等情况——保持当前表情即可
    }
  }

  // —— 供 IdleScheduler 调用的公共 API ——

  /** 说话手势：随机动作播 1 遍（NORMAL 不打断同优先级，避免手势连切） */
  playGesture(): void {
    void this.motionLayer?.play(this.randomGroup(), 0, MotionPriority.NORMAL, 1)
  }

  /** 待机动作：低优先级，正播任何动作时会被静默拒绝（无需处理） */
  playIdleGesture(): void {
    void this.motionLayer?.play(this.randomGroup(), 0, MotionPriority.IDLE, 1)
  }

  isMotionPlaying(): boolean {
    return this.motionLayer?.isPlaying ?? false
  }

  getState(): TurnState {
    return this.state
  }

  /** 注视脉冲目标（模型空间，y 向上为正） */
  setGazeImpulse(x: number, y: number): void {
    this.gazeImpulse = { x, y }
  }

  getCursor(): { x: number; y: number; warm: number } {
    return { x: this.cursorX, y: this.cursorY, warm: this.cursorInside ? 1 : 0 }
  }

  /** 眨眼（多眨为连眨） */
  blink(cycles = 1): void {
    this.procedural?.blink(cycles)
  }

  private randomGroup(): string {
    return `random${1 + Math.floor(Math.random() * RANDOM_MOTION_COUNT)}`
  }

  // —— 光标跟随 ——

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.cursorX = (e.clientX / window.innerWidth) * 2 - 1
    this.cursorY = (e.clientY / window.innerHeight) * 2 - 1
    this.cursorInside = true
  }

  private readonly onPointerLeave = (): void => {
    // 窗口失焦视为光标离开：程序层按衰减速率把跟随缓回中立位
    this.cursorInside = false
  }

  // —— 变换 / 生命周期 ——

  private applyTransform(): void {
    const model = this.model
    if (!model) return
    const { scale, positionX, positionY } = useLive2dStore.getState().avatar
    model.scale.set(scale)
    model.x = this.container.clientWidth / 2 + positionX
    model.y = this.container.clientHeight / 2 + positionY
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.emotionTimer) {
      clearTimeout(this.emotionTimer)
      this.emotionTimer = null
    }
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('blur', this.onPointerLeave)
    this.unsubscribe?.()
    this.unsubscribe = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.motionLayer?.destroy()
    this.motionLayer = null
    this.procedural = null
    if (window.__live2d === this) delete window.__live2d
    if (this.app) {
      PIXI.Ticker.shared.remove(this.tick)
      // removeView=false：canvas 是 React 拥有的 DOM 节点，不能从文档移除
      this.app.destroy(false, { children: true, texture: true, baseTexture: true })
      this.app = null
    }
    this.model = null
  }
}

/** 引擎工厂：由 Live2DStage 的 effect 创建（StrictMode 双挂载每次得到独立实例） */
export function createEngine(canvas: HTMLCanvasElement, container: HTMLElement): Live2DEngine {
  return new Live2DEngine(canvas, container)
}
