import * as PIXI from 'pixi.js'
// 必须从 /cubism4 子路径导入：包根入口（index.es.js）在模块顶层
// 无条件检查 window.Live2D（Cubism 2 运行时），缺省直接 throw。
// cubism4 构建只依赖 Live2DCubismCore，且兼容 Cubism 3 模型。
import { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4'
import type { Emotion } from '@pi-amadeus/shared'
import { useLive2dStore } from '@renderer/stores/live2dStore'

// 模块级注册一次：此后 Live2DModel 的每帧 update 由 PIXI 共享 ticker 驱动
Live2DModel.registerTicker(PIXI.Ticker)

const MODEL_DIR = 'live2dmodels/steinsGateKurisuNew/'
const MODEL_FILE = '红莉栖.model3.json'
// BASE_URL：dev 为 '/'，build 为 './'（file:// 下可用）
const MODEL_URL = `${import.meta.env.BASE_URL}${MODEL_DIR}${encodeURIComponent(MODEL_FILE)}`

// 手动驱动的参数（model3.json 的 LipSync/EyeBlink 组为空，已确认 .cdi3.json 中存在）
const EYE_L = 'ParamEyeLOpen'
const EYE_R = 'ParamEyeROpen'
const MOUTH = 'ParamMouthOpenY'
const LIP_FREQ_HZ = 5

interface ModelSettingsJson {
  url?: string
  FileReferences?: unknown
  Groups?: unknown
  [key: string]: unknown
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Live2D 引擎单实例（每挂载一个）：PIXI Application + 模型加载 + 状态订阅。
 * 生命周期契约：
 * - destroy() 幂等、不删 canvas DOM（节点归 React）
 * - 迟到 Promise 靠 destroyed 标志静默丢弃（StrictMode 双挂载安全）
 */
export class Live2DEngine {
  private app: PIXI.Application | null = null
  private model: Live2DModel | null = null
  private destroyed = false
  private unsubscribe: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null
  private lipSeconds = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement
  ) {}

  isDestroyed(): boolean {
    return this.destroyed
  }

  private get core(): { setParameterValueById(id: string, value: number): void } | null {
    // coreModel 的声明类型是 CubismModel 联合（Cubism2/4），这里只取需要的方法
    return (this.model?.internalModel.coreModel as unknown) as {
      setParameterValueById(id: string, value: number): void
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
    this.setExpression(useLive2dStore.getState().emotion)

    app.ticker.add(this.tick)
    this.unsubscribe = useLive2dStore.subscribe((state, prev) => {
      if (this.destroyed || !this.model) return
      if (state.emotion !== prev.emotion) this.setExpression(state.emotion)
      if (state.motion !== prev.motion && state.motion !== null) {
        void this.playMotion(state.motion.group, state.motion.index)
      }
      if (state.avatar !== prev.avatar) this.applyTransform()
    })
    this.resizeObserver = new ResizeObserver(() => this.applyTransform())
    this.resizeObserver.observe(this.container)

    window.__live2d = this
  }

  /** 每帧：口型 = store 幅度 × 正弦 LFO（M1 假驱动，M4 换真实 TTS 幅度） */
  private readonly tick = (deltaTime: number): void => {
    if (this.destroyed) return
    const core = this.core
    if (!core) return
    this.lipSeconds += deltaTime / 60
    const amp = useLive2dStore.getState().lipSyncValue
    const open = amp * (0.5 + 0.5 * Math.sin(this.lipSeconds * Math.PI * 2 * LIP_FREQ_HZ))
    core.setParameterValueById(MOUTH, open)
  }

  setExpression(name: Emotion): void {
    if (!this.model) return
    try {
      this.model.expression(name)
    } catch {
      // 表情文件缺失等情况——保持当前表情即可
    }
  }

  async playMotion(group: string, index: number, priority: MotionPriority = MotionPriority.NORMAL): Promise<void> {
    if (!this.model) return
    try {
      await this.model.motion(group, index, priority)
    } catch {
      // 播放被拒绝（更高优先级占用）或文件缺失——忽略
    }
  }

  /** 待机随机动作：低频、低优先级，避免喧宾夺主 */
  playIdleMotion(): void {
    const group = `random${1 + Math.floor(Math.random() * 5)}`
    void this.playMotion(group, 0, MotionPriority.IDLE)
  }

  /** 注视目标（模型坐标系，中心 0,0，±1 量级） */
  focus(x: number, y: number): void {
    this.model?.focus(x, y)
  }

  /** 眨眼：10% 双眨 */
  async blink(): Promise<void> {
    const core = this.core
    if (!core) return
    const set = (v: number): void => {
      core.setParameterValueById(EYE_L, v)
      core.setParameterValueById(EYE_R, v)
    }
    const cycles = Math.random() < 0.1 ? 2 : 1
    for (let i = 0; i < cycles; i++) {
      set(0)
      await sleep(70)
      if (this.destroyed) return
      set(1)
      if (i < cycles - 1) await sleep(60)
    }
  }

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
    this.unsubscribe?.()
    this.unsubscribe = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (window.__live2d === this) delete window.__live2d
    if (this.app) {
      this.app.ticker.remove(this.tick)
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
