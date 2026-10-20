import * as PIXI from 'pixi.js'
// 必须从 /cubism4 子路径导入：包根入口（index.es.js）在模块顶层
// 无条件检查 window.Live2D（Cubism 2 运行时），缺省直接 throw。
// cubism4 构建只依赖 Live2DCubismCore，且兼容 Cubism 3 模型。
import { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4'
import { normalizeEmotion, normalizeGesture, type Emotion, type Gesture } from '@pi-amadeus/shared'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { DrawableFx } from './drawable-fx'
import { EXPRESSIONS, resolveExpression, resolveRecipe, type ExpressionRecipe, type ResolvedExpression } from './expressions'
import {
  debugGestureDefs,
  debugOverrideGesture,
  GesturePlayer,
  isGestureName,
  type GestureDef,
  type GestureName
} from './gestures'
import { MotionLayer } from './motion-layer'
import { getModelProfile, modelUrl, type Live2dModelId, type ModelProfile } from './models'
import { OverlayLayer } from './overlays'
import { IDLE_PERFORMANCES, randomPerformance, type Performance } from './performances'
import { ProceduralLayer } from './procedural-layer'

// 模块级注册一次：此后 Live2DModel 的每帧 update 由 PIXI.Ticker.shared 驱动。
// 顺序契约：模型 update 在 Live2DModel.from() 时加入 shared ticker，
// 引擎 tick 在 load() 完成后才加入（同一 ticker、更晚注册）→
// 共享 ticker 按注册顺序回调，引擎写的参数是每帧最终值。
// 注意：tick 必须挂 shared 而不是 app.ticker（两者是独立的 RAF 循环，无顺序保证）。
Live2DModel.registerTicker(PIXI.Ticker)

// 情绪入场手势防抖：SSE 情绪事件可能连发，只播最后一个情绪的入场手势
const ENTRY_GESTURE_DEBOUNCE_MS = 250
// 空闲多久后情绪回落到 neutral（不说话、不在回合中）
const EMOTION_DECAY_MS = 30_000
// speaking 判定阈值：lipSyncValue 高于此视为嘴在动（TTS 的自然延伸器）
// 唯一来源：companion UI（useCompanionStatus / StageBay）从本模块 import 共用，改值前先确认两处消费方
export const SPEAKING_LIP_THRESHOLD = 0.03
// 脸红淡入淡出速率
const BLUSH_SPEED = 4

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

interface CoreModel {
  setParameterValueById(id: string, value: number): void
  getParameterValueById(id: string): number
}

export interface EngineOptions {
  /**
   * stage（默认）：容器居中 + live2dStore 中该模型的摆位；
   * free：由 setPlacement 指定容器内坐标与缩放（桌宠：角色在全屏透明窗口里自由摆放）
   */
  placement?: 'stage' | 'free'
  /** 加载哪个模型；缺省取 store 里当前选中的模型 */
  modelId?: Live2dModelId
}

/** 模型锚点（中心）在容器内的位置（CSS 像素）与缩放 */
export interface Placement {
  x: number
  y: number
  scale: number
}

/** 命中检测用到的 Cubism 网格接口（coreModel 声明类型是 Cubism2/4 联合，只取需要的） */
interface MeshCore {
  getDrawableCount(): number
  getDrawableDynamicFlagIsVisible(index: number): boolean
  getDrawableOpacity(index: number): number
  /** 顶点（网格单位，y 向上） */
  getDrawableVertices(index: number): Float32Array
  getDrawableVertexIndices(index: number): Uint16Array
}

// 不透明度低于此值的网格不算命中（脸红等叠加网格平时为 0）
const HIT_MIN_OPACITY = 0.1

/** 点是否在三角形内（含边）：三条边叉积同号 */
function inTriangle(px: number, py: number, v: Float32Array, a: number, b: number, c: number): boolean {
  const ax = v[a * 2]!
  const ay = v[a * 2 + 1]!
  const bx = v[b * 2]!
  const by = v[b * 2 + 1]!
  const cx = v[c * 2]!
  const cy = v[c * 2 + 1]!
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * Live2D 引擎单实例（每挂载一个）：PIXI Application + 模型加载 + 分层动画装配。
 * 分层：MotionLayer（模型自带动作，一遍即停）→ ProceduralLayer（表情配方 + 待机表演，每帧最后写）
 * → GesturePlayer（程序手势增量）→ DrawableFx（脸红等网格不透明度覆盖）→ OverlayLayer（漫画符号）。
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
  private gestures = new GesturePlayer()
  private fx: DrawableFx | null = null
  private overlays: OverlayLayer | null = null
  private entryTimer: ReturnType<typeof setTimeout> | null = null
  /** 小表演（动作 × 表情）的表情回落定时器；非空表示正在表演 */
  private performanceTimer: ReturnType<typeof setTimeout> | null = null
  private elapsed = 0
  // 光标：归一化 -1..1（窗口中心原点）+ 是否在窗口内
  private cursorX = 0
  private cursorY = 0
  private cursorInside = false
  private gazeImpulse = { x: 0, y: 0 }
  private state: TurnState = { busy: false, speaking: false }
  private lastActiveAt = 0
  private blushCheek = 0
  private blushShy = 0
  private zoom = 0
  private lift = 0
  private tilt = 0
  private wasSpeaking = false
  /** 整体歪头的旋转中心（模型局部坐标，首帧网格就绪后取一次） */
  private neck: { x: number; y: number } | null = null
  /** free 摆放的当前位置（未设置前缩放为 0，不绘制） */
  private placement: Placement | null = null
  /** 本次实例使用的模型档案（模型切换由 Live2DStage 重建引擎完成） */
  private readonly profile: ModelProfile

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    private readonly options: EngineOptions = {}
  ) {
    this.profile = getModelProfile(options.modelId ?? useLive2dStore.getState().modelId)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  private get core(): CoreModel | null {
    // coreModel 的声明类型是 CubismModel 联合（Cubism2/4），这里只取需要的方法
    return (this.model?.internalModel.coreModel as unknown as CoreModel | undefined) ?? null
  }

  async load(): Promise<void> {
    const url = modelUrl(this.profile)
    const res = await fetch(url)
    if (this.destroyed) return
    if (!res.ok) throw new Error(`${this.profile.file} 加载失败: HTTP ${res.status}`)
    const json = (await res.json()) as ModelSettingsJson
    if (this.destroyed) return
    // settings.url 钉成绝对地址：moc3/贴图/physics/exp/motion 的相对路径都按它解析
    const settings = { ...json, url } as unknown as Parameters<typeof Live2DModel.from>[0]

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
      // 迟到加载：挂载已卸载，清理后退出。
      // destroy() 若已处理过这个 app（this.app 置空），这里不再二次销毁（PIXI 不允许重复 destroy）
      model.destroy()
      if (this.app === app) {
        this.app = null
        app.destroy(false)
      }
      return
    }

    this.model = model
    model.interactive = false
    model.anchor.set(0.5, 0.5)
    app.stage.addChild(model)
    this.applyTransform()

    // 分层装配。表情不再用 exp3 文件（它们只是 6 张脸的开关），统一由程序层按配方驱动。
    // 网格覆盖与漫画符号依赖红莉栖的网格 ID：其它模型只在程序层用参数驱动，
    // 不构造这两层（构造了也找不到锚点，画不出来）。
    this.motionLayer = new MotionLayer(model)
    this.procedural = new ProceduralLayer(this.profile)
    this.motionLayer.preserve(this.procedural.managedIds)
    this.fx = this.profile.drawables
      ? new DrawableFx(model.internalModel.coreModel as unknown as ConstructorParameters<typeof DrawableFx>[0])
      : null
    this.overlays = this.profile.overlays ? new OverlayLayer(model) : null
    this.applyEmotion(useLive2dStore.getState().emotion, false)
    this.lastActiveAt = performance.now()

    // 挂 shared ticker（模型 update 之后注册 → 每帧晚于模型执行，参数写入为最终值）
    PIXI.Ticker.shared.add(this.tick)
    this.unsubscribe = useLive2dStore.subscribe((state, prev) => {
      if (this.destroyed || !this.model) return
      if (state.emotion !== prev.emotion) {
        // 真实情绪（LLM / 预览）优先：先撤掉待机或戳一戳的小表演
        this.clearPerformance()
        this.applyEmotion(state.emotion, true)
      }
      if (state.gesture && state.gesture !== prev.gesture) this.playGesture(state.gesture.name)
      if (state.avatars !== prev.avatars) this.applyTransform()
    })
    this.resizeObserver = new ResizeObserver(() => this.applyTransform())
    this.resizeObserver.observe(this.container)

    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('blur', this.onPointerLeave)
    // 指针移出窗口但窗口未失焦（多屏/多窗口常见）时 blur 不触发，靠 document 的 mouseleave 兜底
    document.addEventListener('mouseleave', this.onPointerLeave)

    window.__live2d = this
  }

  /** 每帧：状态机 → 手势采样 → 程序层写参数 → 脸红覆盖 → 漫画符号 → 整体缩放位移 */
  private readonly tick = (deltaTime: number): void => {
    if (this.destroyed) return
    const core = this.core
    const procedural = this.procedural
    if (!core || !procedural) return
    // PIXI v6 Ticker deltaTime 是帧（60fps 基准）→ /60 转秒
    const dt = deltaTime / 60
    this.elapsed += dt

    this.state = this.computeState()
    // 说话沿：结束在手的待机小表演，停掉模型自带动作——动作曲线会拥有口/眼参数并盖住语音口型与眨眼
    // （程序层从动作现值重播种，平滑接续，无跳变）
    if (this.state.speaking && !this.wasSpeaking) {
      this.endPerformance()
      if (this.motionLayer?.isPlaying) this.motionLayer.stop()
    }
    this.wasSpeaking = this.state.speaking
    const gesture = this.gestures.update(dt)
    procedural.update(
      {
        dt,
        t: this.elapsed,
        busy: this.state.busy,
        speaking: this.state.speaking,
        lipTarget: useLive2dSpeechStore.getState().lipSyncValue,
        gazeImpulse: this.gazeImpulse,
        cursor: { x: this.cursorX, y: this.cursorY, warm: this.cursorInside ? 1 : 0 },
        gesture
      },
      core,
      this.motionLayer?.active?.ownedParams ?? null
    )

    this.updateBlush(dt)
    this.overlays?.update(dt)

    this.neck ??= this.overlays?.neckPoint() ?? null
    const tilt = Math.round(procedural.tiltDeg * 100) / 100
    if (gesture.zoom !== this.zoom || gesture.lift !== this.lift || tilt !== this.tilt) {
      this.zoom = gesture.zoom
      this.lift = gesture.lift
      this.tilt = tilt
      this.applyTransform()
    }

    this.decayEmotion()
  }

  /** 回合状态：两路并存用 OR；speaking 由时间戳 + TTS 幅度双信号判定 */
  private computeState(): TurnState {
    const speech = useLive2dSpeechStore.getState()
    const streaming = useSessionStore.getState().stream.streaming
    const now = performance.now()
    return {
      busy: speech.voiceActive || streaming,
      speaking: now < speech.speakingUntil || speech.lipSyncValue > SPEAKING_LIP_THRESHOLD
    }
  }

  /** 两种脸红按配方平滑过渡，写成网格不透明度覆盖 */
  private updateBlush(dt: number): void {
    const procedural = this.procedural
    const fx = this.fx
    const drawables = this.profile.drawables
    if (!procedural || !fx || !drawables) return
    const target = procedural.blush
    const k = 1 - Math.exp(-BLUSH_SPEED * dt)
    this.blushCheek += (target.cheek - this.blushCheek) * k
    this.blushShy += (target.shy - this.blushShy) * k
    for (const id of drawables.cheekBlush) fx.setOpacity(id, this.blushCheek)
    for (const id of drawables.shyBlush) fx.setOpacity(id, this.blushShy)
  }

  /** 空闲足够久，情绪回落到 neutral（经 store，界面与引擎一致） */
  private decayEmotion(): void {
    const now = performance.now()
    if (this.state.busy || this.state.speaking) {
      this.lastActiveAt = now
      return
    }
    const store = useLive2dStore.getState()
    if (store.emotion !== 'neutral' && now - this.lastActiveAt > EMOTION_DECAY_MS) {
      store.setEmotion('neutral')
    }
  }

  // —— 情绪与动作 ——

  /** 切到情绪配方：换脸时眨眼遮住过渡；入场手势防抖后播放 */
  private applyEmotion(emotion: Emotion, withEntry: boolean): void {
    this.applyResolved(resolveExpression(emotion), withEntry)
  }

  private applyResolved(expr: ResolvedExpression, withEntry: boolean): void {
    const procedural = this.procedural
    if (!procedural) return
    const prevFace = procedural.expression.face
    procedural.setExpression(expr)
    this.lastActiveAt = performance.now()
    // 模型自带动作会覆盖眼/嘴/头，切情绪时立即停掉，新表情马上可见
    if (this.motionLayer?.isPlaying) this.motionLayer.stop()
    if (prevFace !== expr.face) procedural.blink()
    this.overlays?.setActive(expr.overlays)
    if (this.entryTimer) {
      clearTimeout(this.entryTimer)
      this.entryTimer = null
    }
    if (withEntry && expr.entry) {
      const entry = expr.entry
      this.entryTimer = setTimeout(() => {
        this.entryTimer = null
        if (!this.destroyed) this.playGestureName(entry)
      }, ENTRY_GESTURE_DEBOUNCE_MS)
    }
  }

  /** 一次性动作（LLM【动】行 / 预览按钮）：抱臂/放下改持续姿态，其余播程序手势 */
  playGesture(name: Gesture): void {
    if (name === 'crossarms') {
      this.procedural?.setArms(1)
      return
    }
    if (name === 'uncross') {
      this.procedural?.setArms(0)
      return
    }
    this.playGestureName(name)
  }

  private playGestureName(name: GestureName): void {
    // 手势是增量：模型自带动作拥有参数时会被吞掉，先停
    if (this.motionLayer?.isPlaying) this.motionLayer.stop()
    this.gestures.play(name)
  }

  // —— 供 IdleScheduler 调用的公共 API ——

  /** 说话时的手势：一律播本表情的程序手势。
   *  模型自带动作会拥有口/眼参数、在渲染时盖住语音口型与眨眼（程序层在 tick 的写入到不了绘制），
   *  所以 random1-5 只在待机时用（见 playIdlePerformance），说话期间不播 */
  playTalkingGesture(): void {
    const expr = this.procedural?.expression
    if (!expr) return
    const pool: GestureName[] = expr.idle.length ? expr.idle : ['nod']
    this.playGestureName(pool[Math.floor(Math.random() * pool.length)]!)
  }

  /**
   * 待机表演：动作 × 表情的组合（桌宠与陪伴页共用的待机调度从这里取）。
   * 中性情绪下随机挑一段小表演——模型自带动作或程序手势，都配一张脸；
   * 已有真实情绪（LLM）时按该情绪的习惯走，不抢戏。
   */
  playIdlePerformance(): void {
    // 已经在表演中：保持当前组合演完，不叠一段新的（叠上去会同时换脸换动作，像抽搐）
    if (!this.procedural || this.performanceTimer) return
    // 有真实情绪（LLM / 预览）时：待机走该情绪自己的手势，不让随机小表演覆盖它
    if (useLive2dStore.getState().emotion !== 'neutral') {
      this.playIdleGesture()
      return
    }
    // 中性 → 表演中：随机挑一段「表情 × 动作」
    this.startPerformance(randomPerformance(IDLE_PERFORMANCES))
  }

  /** 按当前情绪的待机池播手势（有真实情绪时的原待机行为） */
  private playIdleGesture(): void {
    const expr = this.procedural?.expression
    if (!expr) return
    if (expr.randomMotions && (expr.idle.length === 0 || Math.random() < 0.5)) {
      const motion = this.randomIdleMotion()
      void this.motionLayer?.play(motion.group, motion.index, MotionPriority.IDLE, 1)
      return
    }
    if (expr.idle.length === 0 || this.gestures.isPlaying()) return
    this.playGestureName(expr.idle[Math.floor(Math.random() * expr.idle.length)]!)
  }

  /**
   * 一段小表演：先换表情再播动作——换表情会停掉在手的模型自带动作，顺序反过来动作会被吃掉。
   * 动作演完（holdMs）后表情回落到 store 里的当前情绪。
   */
  private startPerformance(perf: Performance): void {
    // 上一段表演 / 待机 → 新表演：先撤掉旧的回落定时器，否则旧定时器会把新表情提前打回
    this.clearPerformance()
    this.applyResolved(resolveExpression(perf.emotion), false)
    if (perf.gesture) this.playGestureName(perf.gesture)
    else {
      const motion = this.randomIdleMotion()
      void this.motionLayer?.play(motion.group, motion.index, MotionPriority.IDLE, 1)
    }
    this.performanceTimer = setTimeout(() => {
      // 表演中 → 回落到 store 的当前情绪（期间没有新的真实情绪，否则订阅回调已提前撤掉定时器）
      this.performanceTimer = null
      if (!this.destroyed) this.applyEmotion(useLive2dStore.getState().emotion, false)
    }, perf.holdMs)
  }

  /** 戳一戳 / 预览：演一段表情 × 动作；回合进行中不打断，返回是否真的演了 */
  perform(perf: Performance): boolean {
    if (this.destroyed || !this.procedural) return false
    // 回合中（语音回合 / 思考 / 说话）不切表情：说话口型与情绪由回合状态接管
    if (this.state.busy || this.state.speaking) return false
    this.startPerformance(perf)
    return true
  }

  /** 提前结束小表演（开始说话等打断场景）：表演中 → 当前情绪 */
  private endPerformance(): void {
    if (!this.performanceTimer) return
    this.clearPerformance()
    if (!this.destroyed) this.applyEmotion(useLive2dStore.getState().emotion, false)
  }

  private clearPerformance(): void {
    if (this.performanceTimer) {
      clearTimeout(this.performanceTimer)
      this.performanceTimer = null
    }
  }

  isMotionPlaying(): boolean {
    return (this.motionLayer?.isPlaying ?? false) || this.gestures.isPlaying()
  }

  getState(): TurnState {
    return this.state
  }

  /** 注视脉冲目标（观察者坐标：画面右 +x、上 +y） */
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

  private randomIdleMotion(): { group: string; index: number } {
    const motions = this.profile.idleMotions
    return motions[Math.floor(Math.random() * motions.length)] ?? { group: 'Idle', index: 0 }
  }

  // —— 调试钩子（window.__live2d；scripts/live2d-shot.mjs 截图与调参用） ——

  /** 按名字切情绪（兼容旧名），与 SSE 事件走同一条 store 路径 */
  emote(name: string): Emotion | null {
    const emotion = normalizeEmotion(name)
    if (emotion) useLive2dStore.getState().setEmotion(emotion)
    return emotion
  }

  /** 按名字播动作（含内部手势 yawn/glance） */
  gesture(name: string): boolean {
    const gesture = normalizeGesture(name)
    if (gesture) {
      this.playGesture(gesture)
      return true
    }
    if (isGestureName(name)) {
      this.playGestureName(name)
      return true
    }
    return false
  }

  /** 直接应用一份临时配方（调参预览，不经 store） */
  previewRecipe(recipe: ExpressionRecipe, withEntry = false): void {
    this.applyResolved(resolveRecipe(recipe), withEntry)
  }

  /** 当前情绪配方表（只读，调参对照） */
  debugRecipes(): Record<Emotion, ExpressionRecipe> {
    return EXPRESSIONS
  }

  /** 手势定义表 / 临时覆盖某个手势（调参用，刷新页面即恢复） */
  debugGestures(): Readonly<Record<GestureName, GestureDef>> {
    return debugGestureDefs()
  }

  debugDefineGesture(name: string, def: GestureDef): boolean {
    if (!isGestureName(name)) return false
    debugOverrideGesture(name, def)
    return true
  }

  /** 读取若干参数的当前值 */
  debugParams(ids: string[]): Record<string, number> {
    const core = this.core
    const out: Record<string, number> = {}
    if (core) for (const id of ids) out[id] = Math.round(core.getParameterValueById(id) * 1000) / 1000
    return out
  }

  /** 冻结时游走器原始 min/max（解冻恢复用） */
  private frozenSway: Array<{ min: number; max: number }> | null = null

  /** 冻结随机性：头身游走归零、关掉库自带的呼吸摆动（截图可复现）；解冻时原样恢复 */
  debugFreeze(on: boolean): void {
    const internal = this.model?.internalModel as unknown as { breath?: unknown; __breath?: unknown } | undefined
    const walkers = (this.procedural as unknown as { walkers?: Record<string, { min: number; max: number; target: number; value: number }> } | null)?.walkers
    if (walkers) {
      const list = Object.values(walkers)
      if (on) {
        this.frozenSway ??= list.map((w) => ({ min: w.min, max: w.max }))
        for (const w of list) {
          w.min = 0
          w.max = 0
          w.target = 0
          w.value = 0
        }
      } else if (this.frozenSway) {
        list.forEach((w, i) => {
          const saved = this.frozenSway![i]
          if (saved) {
            w.min = saved.min
            w.max = saved.max
          }
        })
        this.frozenSway = null
      }
    }
    if (internal) {
      if (on && internal.breath) {
        internal.__breath = internal.breath
        internal.breath = undefined
      } else if (!on && internal.__breath) {
        internal.breath = internal.__breath
      }
    }
  }

  /** 脸部区域（容器坐标，CSS 像素）：桌宠对话框按它贴在头部一侧；网格尚未算出时 null */
  faceRect(): { x: number; y: number; width: number; height: number } | null {
    return this.overlays?.regionOnScreen('face') ?? this.boundsRegion('face')
  }

  /**
   * 没有逐网格锚点的模型（mao/shizuku）用整体包围盒估算头/脸区域。
   * 只用于把桌宠对话框贴到角色旁边，不用于漫画符号定位。
   */
  private boundsRegion(kind: 'face' | 'head'): { x: number; y: number; width: number; height: number } | null {
    const model = this.model
    if (!model) return null
    const b = model.getBounds()
    if (!(b.width > 0 && b.height > 0)) return null
    if (kind === 'head') {
      return { x: b.x + b.width * 0.1, y: b.y, width: b.width * 0.8, height: b.height * 0.55 }
    }
    // 脸大致在模型上部居中：宽 60%、高 32%
    return { x: b.x + b.width * 0.2, y: b.y + b.height * 0.04, width: b.width * 0.6, height: b.height * 0.32 }
  }

  /** 截图区域（CSS 像素）：face 面部特写 / head 头部含符号余量 */
  debugRegion(kind: string): { x: number; y: number; width: number; height: number } | null {
    if (kind !== 'face' && kind !== 'head') return null
    return this.overlays?.regionOnScreen(kind) ?? this.boundsRegion(kind)
  }

  /** 调试钩子：当前模型 ID（模型切换的 e2e 断言用） */
  getModelProfileId(): Live2dModelId {
    return this.profile.id
  }

  // —— 光标跟随 ——

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.cursorX = (e.clientX / window.innerWidth) * 2 - 1
    this.cursorY = (e.clientY / window.innerHeight) * 2 - 1
    this.cursorInside = true
  }

  private readonly onPointerLeave = (): void => {
    // 窗口失焦或指针移出文档视为光标离开：程序层按衰减速率把跟随缓回中立位
    this.cursorInside = false
  }

  // —— 变换 / 生命周期 ——

  /** free 摆放：设置角色位置与缩放 */
  setPlacement(placement: Placement): void {
    this.placement = placement
    this.applyTransform()
  }

  /** free 摆放的当前位置（未设置时 null） */
  getPlacement(): Placement | null {
    return this.placement
  }

  /** 模型画布原始尺寸（缩放为 1 时的 CSS 像素）；模型未加载时 null */
  getModelSize(): { width: number; height: number } | null {
    const internal = this.model?.internalModel
    return internal ? { width: internal.width, height: internal.height } : null
  }

  /**
   * 角色当前可见包围盒（容器坐标，CSS 像素）：陪伴舞台的落地影跟随角色用。
   * 取可见网格顶点的包围盒，不用 PIXI 的 getBounds（那是整张画布，
   * 含透明留白，画布底边往往在舞台外）。
   */
  getModelBounds(): { x: number; y: number; width: number; height: number } | null {
    const model = this.model
    if (!model) return null
    const internal = model.internalModel as unknown as {
      coreModel: MeshCore
      pixelsPerUnit: number
      originalWidth: number
      originalHeight: number
    }
    const core = internal.coreModel
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const count = core.getDrawableCount()
    for (let i = 0; i < count; i++) {
      if (!core.getDrawableDynamicFlagIsVisible(i) || core.getDrawableOpacity(i) < HIT_MIN_OPACITY) continue
      const vertices = core.getDrawableVertices(i)
      // 网格单位（y 向上）→ 模型画布坐标（y 向下，与 hitTest 的逆变换一致）
      for (let j = 0; j + 1 < vertices.length; j += 2) {
        const x = vertices[j]! * internal.pixelsPerUnit + internal.originalWidth / 2
        const y = -vertices[j + 1]! * internal.pixelsPerUnit + internal.originalHeight / 2
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (!(maxX > minX) || !(maxY > minY)) return null
    // 仿射变换下极值落在四角：只变换四个角，避免逐顶点转世界坐标
    const corners = [
      model.toGlobal(new PIXI.Point(minX, minY)),
      model.toGlobal(new PIXI.Point(maxX, minY)),
      model.toGlobal(new PIXI.Point(minX, maxY)),
      model.toGlobal(new PIXI.Point(maxX, maxY))
    ]
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }

  /**
   * 命中检测：容器坐标（CSS 像素）是否落在角色当前可见的网格上。
   * 逐三角形判断（模型没有 HitArea，用包围盒会把发丝间、身侧的空白也算进来）；
   * 用上一帧的世界变换，歪头/缩放/手势位移都已计入。
   */
  hitTest(x: number, y: number): boolean {
    const model = this.model
    if (!model || model.scale.x <= 0) return false
    const internal = model.internalModel as unknown as {
      coreModel: MeshCore
      pixelsPerUnit: number
      originalWidth: number
      originalHeight: number
    }
    // 容器坐标 → 模型画布像素（toModelPosition）→ 网格单位（与 getDrawableVertices 原始值同空间）
    const p = model.toModelPosition(new PIXI.Point(x, y), undefined, true)
    const ux = (p.x - internal.originalWidth / 2) / internal.pixelsPerUnit
    const uy = -(p.y - internal.originalHeight / 2) / internal.pixelsPerUnit
    const core = internal.coreModel
    const count = core.getDrawableCount()
    for (let i = 0; i < count; i++) {
      if (!core.getDrawableDynamicFlagIsVisible(i) || core.getDrawableOpacity(i) < HIT_MIN_OPACITY) continue
      const vertices = core.getDrawableVertices(i)
      const indices = core.getDrawableVertexIndices(i)
      for (let t = 0; t + 2 < indices.length; t += 3) {
        if (inTriangle(ux, uy, vertices, indices[t]!, indices[t + 1]!, indices[t + 2]!)) return true
      }
    }
    return false
  }

  private basePlacement(): Placement {
    if (this.options.placement === 'free') return this.placement ?? { x: 0, y: 0, scale: 0 }
    const { avatars } = useLive2dStore.getState()
    const { scale, positionX, positionY } = avatars[this.profile.id] ?? this.profile.defaultAvatar
    return {
      x: this.container.clientWidth / 2 + positionX,
      y: this.container.clientHeight / 2 + positionY,
      scale
    }
  }

  private applyTransform(): void {
    const model = this.model
    if (!model) return
    const base = this.basePlacement()
    const s = base.scale * (1 + this.zoom)
    model.scale.set(s)
    model.x = base.x
    model.y = base.y + this.lift
    // 整体歪头：绕脖子旋转——旋转中心本是锚点（模型中心），补偿位移让脖子保持不动
    const theta = (this.tilt * Math.PI) / 180
    model.rotation = theta
    if (theta !== 0 && this.neck) {
      const dx = this.neck.x - model.pivot.x
      const dy = this.neck.y - model.pivot.y
      const c = Math.cos(theta)
      const sn = Math.sin(theta)
      model.x += s * (dx - (c * dx - sn * dy))
      model.y += s * (dy - (sn * dx + c * dy))
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.entryTimer) {
      clearTimeout(this.entryTimer)
      this.entryTimer = null
    }
    this.clearPerformance()
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('blur', this.onPointerLeave)
    document.removeEventListener('mouseleave', this.onPointerLeave)
    this.unsubscribe?.()
    this.unsubscribe = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.motionLayer?.destroy()
    this.motionLayer = null
    this.procedural = null
    this.gestures.stop()
    this.fx?.destroy()
    this.fx = null
    this.overlays?.destroy()
    this.overlays = null
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
export function createEngine(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  options?: EngineOptions
): Live2DEngine {
  return new Live2DEngine(canvas, container, options)
}
