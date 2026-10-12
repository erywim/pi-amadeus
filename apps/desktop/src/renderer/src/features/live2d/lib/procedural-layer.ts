import type { ResolvedExpression } from './expressions'
import { resolveExpression } from './expressions'
import type { GestureSample } from './gestures'
import { FACE_KEYS, FACE_PARAMS, P, SIGN, type FaceKey } from './model-params'

/**
 * 程序动画层：引擎每帧最后写模型参数的"表演"层。
 *
 * 与动作层（MotionLayer）通过**参数所有权**共存：
 * - 动作拥有其曲线的参数时程序层让位——动作曲线在渲染时覆写参数缓冲，
 *   本层 tick 里的叠加根本到不了绘制（已在 pixi-live2d-display 0.4.0 源码核查），
 *   因此引擎保证说话期间不播此类动作（live2d-engine 说话沿停机 + playTalkingGesture 只播程序手势）
 * - 动作结束（所有权消失）→ 从模型现值重播种，平滑回到程序目标——
 *   解决"动作硬切后参数卡死在最后帧"的问题
 *
 * 每帧合成：表情配方（情绪脸/眼/嘴/姿态/手臂）作为基线 → 平滑逼近 →
 * 叠加待机摆动、注视、说话点头、思考姿态 → 写入时再叠加手势增量（不经平滑，保持动作干脆）。
 * 方向统一用观察者坐标（画面右 +x、上 +y），写参数时乘 model-params.ts 的实测符号。
 *
 * 子系统：眨眼状态机（缓动）、口型包络（非对称 attack/release + 语素抖动）、
 * 头/身随机游走摆动（+说话点头/思考仰头/光标跟随/注视带动）、注视合成、
 * 情绪脸顺序切换（先退旧脸再进新脸，避免两张脸的组合关键形）。
 */

// —— 调参常量（起步值，可实测微调）——
const BLINK_CLOSE_S = 0.045 // 闭眼
const BLINK_HOLD_S = 0.04 // 闭保持
const BLINK_OPEN_S = 0.095 // 睁眼
const LIP_ATTACK = 14 // 开口快
const LIP_RELEASE = 5 // 闭口慢（去"啪嗒"感）
const GAZE_K = 3.5 // 注视平滑
const ANGLE_SPEED = 6 // 头部合成目标跟随速度
const POSE_SPEED = 4 // 表情姿态（大幅转头/俯仰）
const BODY_SPEED = 5 // 身体
const EYE_SPEED = 8 // 表情眼睛开合
const MOUTH_SPEED = 6 // 表情嘴型/基础张嘴
const FACE_SPEED = 9 // 情绪脸进出
const FACE_SWAP_GATE = 0.08 // 旧脸退到此值以下新脸才进
const ARMS_SPEED = 3 // 手臂（经中间关键形，慢一点才自然）
const SPEAK_ATTACK = 4 // speakStrength 攻击
const SPEAK_RELEASE = 2.5 // speakStrength 释放（迟滞防字间闪断）
const THINK_ATTACK = 3
const THINK_RELEASE = 2
// 摆动幅度（度）
const SWAY_HEAD = { angleX: 8, angleY: 6, angleZ: 5 }
const SWAY_BODY = { x: 3, y: 2, z: 2 }
// 说话/思考姿态
const SPEAK_NOD_AMP = 2.4 // 说话点头幅度（ParamAngleY，度）
const SPEAK_NOD_HZ = 2.1 // 点头频率
const SPEAK_LEAN = 1.2 // 说话时身体微动（BodyAngleX）
const THINK_TILT_UP = 4 // 思考仰头（ParamAngleY）
const THINK_TILT_Z = 2 // 思考侧倾
// 光标跟随（度，光标在窗口边缘时达最大值）
const CURSOR_YAW = 6
const CURSOR_PITCH = 4
const CURSOR_DECAY = 2 // 光标离开窗口后温暖度衰减速率
// 注视带动头部（度，单位注视向量分量满值时）
const GAZE_LEAN_PITCH = 6
const GAZE_LEAN_YAW = 8
const GAZE_LEAN_BODY = 1.5
// 思考注视点（观察者坐标：右上方）
const THINK_GAZE = { x: 0.35, y: 0.6 }
// 说话时注视收敛到正前方（看着用户）
const SPEAK_GAZE_SHRINK = 0.15
// 呼吸基线：库自带呼吸在其上 ±0.25 摆动（基线 0 时负半周被截掉，只剩半程呼吸）
const BREATH_BASE = 0.25
// 歪头：ParamAngleZ 在本模型里几乎不转头，按比例让整个形象绕脖子转（roll 20 → 4°）
const ROLL_TO_TILT = 0.2

interface Core {
  setParameterValueById(id: string, value: number): void
  getParameterValueById(id: string): number
}

export interface ProceduralInput {
  /** 本帧时长（秒） */
  dt: number
  /** 累计时间（秒） */
  t: number
  /** 回合进行中（语音或文本流） */
  busy: boolean
  /** 正在说话（嘴在动） */
  speaking: boolean
  /** 口型目标 0..1（ttsPlayer 的实时 RMS） */
  lipTarget: number
  /** 注视脉冲目标（观察者坐标，画面右 +x、上 +y），由 IdleScheduler 供给 */
  gazeImpulse: { x: number; y: number }
  /** 光标：归一化 -1..1（窗口中心为原点，y 向下）+ 活跃度 0..1 */
  cursor: { x: number; y: number; warm: number }
  /** 手势增量（GesturePlayer 本帧采样） */
  gesture: GestureSample
}

interface ManagedParam {
  value: number
  target: number
  speed: number
  /** 写入时乘的方向符号（观察者坐标 → 模型参数） */
  sign: number
  min: number
  max: number
}

interface Walker {
  value: number
  target: number
  nextAt: number
  min: number
  max: number
  intervalMs: [number, number]
  k: number
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min)

const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v

/** 平滑阶梯缓动 0..1 */
const smoothstep01 = (x: number): number => {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

/** 指数平滑单步：value 向 target 逼近 */
const approach = (value: number, target: number, k: number, dt: number): number =>
  value + (target - value) * (1 - Math.exp(-k * dt))

function createWalker(min: number, max: number, intervalMs: [number, number], k: number): Walker {
  return { value: 0, target: 0, nextAt: 0, min, max, intervalMs, k }
}

export class ProceduralLayer {
  private blinkPhase: 'open' | 'closing' | 'closed' | 'opening' = 'open'
  private blinkT = 0
  private blinkPending = 0
  private blinkValue = 1
  private lip = 0
  /** 本帧说话口型（包络 × 语素抖动），写入时叠加在表情基础张嘴上 */
  private lipShape = 0
  private speakStrength = 0
  private thinkStrength = 0
  private gaze = { x: 0, y: 0 }
  private cursorWarm = 0
  /** 表情侧倾（平滑后）与本帧整体歪头角度（度） */
  private roll = 0
  private tilt = 0
  /** 手臂两级平滑的中间值（指数逼近起手太突兀，串两级得到 S 形过渡） */
  private armsMid = 1
  private expr: ResolvedExpression = resolveExpression('neutral')
  private armsOverride: number | null = null
  private readonly walkers: Record<string, Walker>
  private readonly params = new Map<string, ManagedParam>()
  private readonly prevOwned = new Set<string>()

  constructor() {
    // 头/身摆动游走器（调试截图时可把 min/max 置 0 冻结）
    this.walkers = {
      angleX: createWalker(-SWAY_HEAD.angleX, SWAY_HEAD.angleX, [2500, 5000], 1.8),
      angleY: createWalker(-SWAY_HEAD.angleY, SWAY_HEAD.angleY, [2500, 5000], 1.8),
      angleZ: createWalker(-SWAY_HEAD.angleZ, SWAY_HEAD.angleZ, [3000, 6000], 1.8),
      bodyX: createWalker(-SWAY_BODY.x, SWAY_BODY.x, [4000, 7000], 1.2),
      bodyY: createWalker(-SWAY_BODY.y, SWAY_BODY.y, [4000, 7000], 1.2),
      bodyZ: createWalker(-SWAY_BODY.z, SWAY_BODY.z, [5000, 8000], 1.2)
    }

    // 注册受管参数（value 初始值会在首帧"未拥有"分支里从模型现值接管，无跳变）
    const reg = (id: string, speed: number, min: number, max: number, sign = 1, value = 0): void => {
      this.params.set(id, { value, target: value, speed, sign, min, max })
    }
    reg(P.angleX, ANGLE_SPEED, -30, 30, SIGN.angleX)
    reg(P.angleY, ANGLE_SPEED, -30, 30, SIGN.angleY)
    reg(P.angleZ, ANGLE_SPEED, -30, 30)
    reg(P.headYaw, POSE_SPEED, -30, 30, SIGN.headYaw)
    reg(P.headPitch, POSE_SPEED, -30, 30, SIGN.headPitch)
    reg(P.bodyX, BODY_SPEED, -10, 10)
    reg(P.bodyY, BODY_SPEED, -10, 10)
    reg(P.bodyZ, BODY_SPEED, -10, 10)
    reg(P.breath, BODY_SPEED, 0, 1, 1, BREATH_BASE)
    reg(P.eyeL, EYE_SPEED, 0, 1, 1, 1)
    reg(P.eyeR, EYE_SPEED, 0, 1, 1, 1)
    reg(P.eyeBallX, GAZE_K, -1, 1, SIGN.eyeBallX)
    reg(P.eyeBallY, GAZE_K, -1, 1, SIGN.eyeBallY)
    reg(P.mouthOpen, MOUTH_SPEED, 0, 1)
    reg(P.mouthForm, MOUTH_SPEED, -1, 1)
    reg(P.arms, ARMS_SPEED, 0, 1, 1, 1)
    for (const key of FACE_KEYS) reg(FACE_PARAMS[key], FACE_SPEED, 0, 1)
  }

  /** 程序层每帧写入的全部参数（动作层停止时不复位它们） */
  get managedIds(): string[] {
    return [...this.params.keys()]
  }

  /** 切换表情配方（手臂临时覆盖随之清除） */
  setExpression(expr: ResolvedExpression): void {
    this.expr = expr
    this.armsOverride = null
  }

  get expression(): ResolvedExpression {
    return this.expr
  }

  /** 手臂临时覆盖（抱臂/放下动作）；null = 跟随表情 */
  setArms(value: number | null): void {
    this.armsOverride = value
  }

  /** 触发眨眼（多眨为快速连眨）。仅睁眼状态接受，返回是否受理 */
  blink(cycles = 1): boolean {
    if (this.blinkPhase !== 'open') return false
    this.blinkPending = Math.max(1, cycles)
    this.blinkPhase = 'closing'
    this.blinkT = 0
    return true
  }

  get isBlinking(): boolean {
    return this.blinkPhase !== 'open'
  }

  /** 本帧整体歪头角度（度，正 = 顺时针）：引擎绕脖子旋转整个形象 */
  get tiltDeg(): number {
    return this.tilt
  }

  /** 当前两颊脸红与"害羞脸"红晕的目标值（引擎用来做网格不透明度覆盖） */
  get blush(): { cheek: number; shy: number } {
    return { cheek: this.expr.cheekBlush, shy: this.expr.shyBlush }
  }

  /** 每帧推进：合成目标 → 按所有权写参数 */
  update(input: ProceduralInput, core: Core, motionOwned: Set<string> | null): void {
    const { dt, t } = input
    this.updateBlink(dt)
    this.updateStrengths(input)
    this.composeTargets(input, t)
    const g = input.gesture
    this.roll = approach(this.roll, this.expr.roll, POSE_SPEED, dt)
    this.tilt = (this.roll + g.roll) * ROLL_TO_TILT

    for (const [id, p] of this.params.entries()) {
      const owned = motionOwned?.has(id) ?? false
      const ownedBefore = this.prevOwned.has(id)

      if (owned) {
        // 动作拥有该参数：程序层让位（此刻写参数缓冲会被随后的动作曲线覆写，叠加无意义）。
        // 说话期间引擎不安排此类动作，语音口型不被抢走
        continue
      }

      // 刚失去所有权：从模型现值重播种（换回观察者坐标），平滑回落无跳变
      if (ownedBefore) p.value = core.getParameterValueById(id) * p.sign

      p.value = approach(p.value, p.target, p.speed, dt)
      core.setParameterValueById(id, clamp(this.finalValue(id, p.value, g), p.min, p.max) * p.sign)
    }

    // 重建上一帧所有权集合
    this.prevOwned.clear()
    if (motionOwned) for (const id of motionOwned) this.prevOwned.add(id)
  }

  /** 平滑值 + 不经平滑的瞬时成分（眨眼、手势、口型） */
  private finalValue(id: string, v: number, g: GestureSample): number {
    switch (id) {
      case P.eyeL:
        return v * this.blinkValue * (1 - clamp(g.eyeCloseL, 0, 1))
      case P.eyeR:
        return v * this.blinkValue * (1 - clamp(g.eyeCloseR, 0, 1))
      case P.mouthOpen:
        // v 是表情的基础张嘴；说话口型在剩余空间里叠加
        return v + this.lipShape * (1 - v) + g.mouthOpen
      case P.mouthForm:
        return v + g.mouthForm
      case P.headYaw:
        return v + g.yaw
      case P.headPitch:
        return v + g.pitch
      case P.angleZ:
        return v + g.roll
      case P.bodyX:
        return v + g.bodyX
      case P.bodyY:
        return v + g.bodyY
      case P.bodyZ:
        return v + g.bodyZ
      case P.eyeBallX:
        return v + g.eyeX
      case P.eyeBallY:
        return v + g.eyeY
      case P.breath:
        return v + g.breath
      default:
        return v
    }
  }

  // —— 内部：子系统 ——

  private updateBlink(dt: number): void {
    switch (this.blinkPhase) {
      case 'open':
        this.blinkValue = 1
        return
      case 'closing':
        this.blinkT += dt
        this.blinkValue = 1 - smoothstep01(this.blinkT / BLINK_CLOSE_S)
        if (this.blinkT >= BLINK_CLOSE_S) {
          this.blinkPhase = 'closed'
          this.blinkT = 0
          this.blinkValue = 0
        }
        return
      case 'closed':
        this.blinkT += dt
        if (this.blinkT >= BLINK_HOLD_S) {
          if (this.blinkPending > 1) {
            this.blinkPending -= 1
            this.blinkPhase = 'closing'
            this.blinkT = 0
          } else {
            this.blinkPhase = 'opening'
            this.blinkT = 0
          }
        }
        return
      case 'opening':
        this.blinkT += dt
        this.blinkValue = smoothstep01(this.blinkT / BLINK_OPEN_S)
        if (this.blinkT >= BLINK_OPEN_S) {
          this.blinkPhase = 'open'
          this.blinkValue = 1
        }
        return
    }
  }

  private updateStrengths(input: ProceduralInput): void {
    const { dt, busy, speaking } = input
    this.speakStrength = approach(
      this.speakStrength,
      speaking ? 1 : 0,
      speaking ? SPEAK_ATTACK : SPEAK_RELEASE,
      dt
    )
    const thinking = busy && !speaking
    this.thinkStrength = approach(
      this.thinkStrength,
      thinking ? 1 : 0,
      thinking ? THINK_ATTACK : THINK_RELEASE,
      dt
    )
    // 光标温暖度：窗口内 1，离开后按 CURSOR_DECAY 衰减
    this.cursorWarm = approach(this.cursorWarm, input.cursor.warm, CURSOR_DECAY, dt)
  }

  /** 合成各参数的目标值（游走器推进 + 表情基线 + 姿态叠加） */
  private composeTargets(input: ProceduralInput, t: number): void {
    const s = this.speakStrength
    const th = this.thinkStrength
    const cw = this.cursorWarm
    const e = this.expr

    // 1) 摆动游走器
    for (const w of Object.values(this.walkers)) {
      if (t >= w.nextAt) {
        w.nextAt = t + rand(w.intervalMs[0], w.intervalMs[1]) / 1000
        w.target = rand(w.min, w.max)
      }
      w.value = approach(w.value, w.target, w.k, input.dt)
    }
    const w = this.walkers

    // 2) 注视：thinking 看右上 / speaking 收敛到正前方 / idle 跟随脉冲；
    //    超出单位圆才归一化（不放大小幅注视）
    const imp = input.gazeImpulse
    let gx = imp.x
    let gy = imp.y
    if (th > 0.01) {
      gx = THINK_GAZE.x
      gy = THINK_GAZE.y
    } else if (s > 0.01) {
      gx = imp.x * SPEAK_GAZE_SHRINK
      gy = imp.y * SPEAK_GAZE_SHRINK
    }
    const mag = Math.hypot(gx, gy)
    if (mag > 1) {
      gx /= mag
      gy /= mag
    }
    this.gaze = {
      x: approach(this.gaze.x, gx, GAZE_K, input.dt),
      y: approach(this.gaze.y, gy, GAZE_K, input.dt)
    }
    const p = this.params
    const look = this.gaze
    const cursorX = input.cursor.x * cw
    const cursorUp = -input.cursor.y * cw

    // 3) 头部：小幅角度 = 摆动 + 注视带动 + 光标跟随 + 说话点头 + 思考仰头；
    //    大幅角度 = 表情姿态
    p.get(P.angleX)!.target = w.angleX!.value + look.x * GAZE_LEAN_YAW + cursorX * CURSOR_YAW
    p.get(P.angleY)!.target =
      w.angleY!.value +
      look.y * GAZE_LEAN_PITCH +
      cursorUp * CURSOR_PITCH +
      Math.sin(t * Math.PI * 2 * SPEAK_NOD_HZ) * SPEAK_NOD_AMP * s +
      THINK_TILT_UP * th
    p.get(P.angleZ)!.target = w.angleZ!.value + THINK_TILT_Z * th + e.roll
    p.get(P.headYaw)!.target = e.yaw
    p.get(P.headPitch)!.target = e.pitch

    // 4) 身体：独立慢摆 + 说话微动 + 注视轻微带动
    p.get(P.bodyX)!.target = w.bodyX!.value + SPEAK_LEAN * s + look.x * GAZE_LEAN_BODY
    p.get(P.bodyY)!.target = w.bodyY!.value
    p.get(P.bodyZ)!.target = w.bodyZ!.value

    // 5) 眼睛：表情开合（眨眼与手势闭眼在写入时相乘）
    p.get(P.eyeL)!.target = e.eyeOpenL
    p.get(P.eyeR)!.target = e.eyeOpenR

    // 6) 眼球：注视 + 表情视线偏置
    p.get(P.eyeBallX)!.target = clamp(look.x + e.eyeX, -1, 1)
    p.get(P.eyeBallY)!.target = clamp(look.y + e.eyeY, -1, 1)

    // 7) 口型：表情基础张嘴 + 说话包络（非对称 + 语素抖动，三正弦不互质）
    const lipRaw = input.lipTarget
    const attack = lipRaw > this.lip
    this.lip = approach(this.lip, lipRaw, attack ? LIP_ATTACK : LIP_RELEASE, input.dt)
    const wobble =
      0.5 +
      (0.5 *
        (Math.sin(t * Math.PI * 2 * 6.7) +
          Math.sin(t * Math.PI * 2 * 4.3 + 1.7) +
          Math.sin(t * Math.PI * 2 * 2.9 + 0.6))) /
        3
    this.lipShape = this.lip > 0.01 ? clamp(this.lip * (0.8 + 0.4 * wobble), 0, 1) : 0
    p.get(P.mouthOpen)!.target = e.mouthOpen
    p.get(P.mouthForm)!.target = e.mouthForm

    // 8) 情绪脸：顺序切换——其他脸还没退下去时，新脸先不进
    for (const key of FACE_KEYS) {
      const param = p.get(FACE_PARAMS[key])!
      const wanted = e.face === key ? e.faceWeight : 0
      param.target = wanted > 0 && this.otherFacesActive(key) ? 0 : wanted
    }

    // 9) 手臂：两级平滑，起止都缓
    this.armsMid = approach(this.armsMid, this.armsOverride ?? e.arms, ARMS_SPEED * 1.6, input.dt)
    p.get(P.arms)!.target = this.armsMid

    // 10) 呼吸基线（手势在写入时叠加；库自带的呼吸摆动在其后相加）
    p.get(P.breath)!.target = BREATH_BASE
  }

  private otherFacesActive(key: FaceKey): boolean {
    for (const other of FACE_KEYS) {
      if (other !== key && this.params.get(FACE_PARAMS[other])!.value > FACE_SWAP_GATE) return true
    }
    return false
  }
}
