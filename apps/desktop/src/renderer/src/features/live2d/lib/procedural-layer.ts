/**
 * 程序动画层：引擎每帧最后写模型参数的"表演"层。
 *
 * 与动作层（MotionLayer）通过**参数所有权**共存：
 * - 动作拥有其曲线的参数时程序层让位（两个特权例外：眨眼、说话口型）
 * - 动作结束（所有权消失）→ 从模型现值重播种，平滑回到程序目标——
 *   解决"动作硬切后眉毛/脸颊等参数卡死在最后帧"的问题
 *
 * 子系统：眨眼状态机（缓动）、口型包络（非对称 attack/release + 语素抖动）、
 * 头/身随机游走摆动（+说话点头/思考仰头/光标跟随/注视带动）、
 * 注视合成（自实现，弃用 model.focus——它有 focus(0,0) 看向最右的 bug）。
 */

// 参数名（与模型资产一致）
const EYE_L = 'ParamEyeLOpen'
const EYE_R = 'ParamEyeROpen'
const MOUTH = 'ParamMouthOpenY'
const ANGLE_X = 'ParamAngleX'
const ANGLE_Y = 'ParamAngleY'
const ANGLE_Z = 'ParamAngleZ'
const BODY_X = 'ParamBodyAngleX'
const BODY_Y = 'ParamBodyAngleY'
const BODY_Z = 'ParamBodyAngleZ'
const EYEBALL_X = 'ParamEyeBallX'
const EYEBALL_Y = 'ParamEyeBallY'

/** 动作硬停后会卡死在最后帧的瞬时参数（随机动作驱动）：目标 = 加载时中性快照 */
const TRANSIENT_IDS = [
  'ParamBrowLY',
  'ParamBrowRY',
  'ParamBrowLForm',
  'ParamBrowRForm',
  'ParamCheek',
  'ParamEyeLSmile',
  'ParamEyeRSmile',
  'Param14',
  'Param15',
  'Param17'
] as const

// —— 调参常量（起步值，可实测微调）——
const BLINK_CLOSE_S = 0.045 // 闭眼
const BLINK_HOLD_S = 0.04 // 闭保持
const BLINK_OPEN_S = 0.095 // 睁眼
const LIP_ATTACK = 14 // 开口快
const LIP_RELEASE = 5 // 闭口慢（去"啪嗒"感）
const GAZE_K = 3.5 // 注视平滑
const ANGLE_SPEED = 6 // 头部合成目标跟随速度
const BODY_SPEED = 5 // 身体
const EYE_SPEED = 10 // 睁眼恢复
const EYE_SPEED_BLINK = 60 // 眨眼期间瞬时跟随
const TAKE_OVER_K = 2 // 动作结束接管回落的平滑速率（0.5-1s 内回位）
const SPEAK_ATTACK = 4 // speakStrength 攻击
const SPEAK_RELEASE = 2.5 // speakStrength 释放（迟滞防字间闪断）
const THINK_ATTACK = 3
const THINK_RELEASE = 2
// 摆动幅度（度）
const SWAY_HEAD = { angleX: 8, angleY: 10, angleZ: 5 }
const SWAY_BODY = { x: 3, y: 2, z: 2 }
// 说话/思考姿态
const SPEAK_NOD_AMP = 2.2 // 说话点头幅度（度）
const SPEAK_NOD_HZ = 2.1 // 点头频率
const SPEAK_LEAN = 1.2 // 说话前倾（BodyAngleX）
const THINK_TILT_UP = 3 // 思考仰头
const THINK_TILT_Z = 1.5 // 思考侧倾
// 光标跟随（度，光标在窗口边缘时达最大值）
const CURSOR_YAW = 5 // 头部左右
const CURSOR_PITCH = 3 // 头部上下
const CURSOR_DECAY = 2 // 光标离开窗口后温暖度衰减速率
// 注视带动头部（度，单位注视向量分量满值时）
const GAZE_LEAN_PITCH = 8
const GAZE_LEAN_YAW = 8
const GAZE_LEAN_BODY = 1.5
// 思考注视点（模型空间，y 向上为正）
const THINK_GAZE = { x: 0.25, y: -0.45 }
// 说话注视收敛系数（凝视中心 ±0.12 微抖）
const SPEAK_GAZE_SHRINK = 0.12

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
  /** 注视脉冲目标（模型空间，y 向上为正），由 IdleScheduler 供给 */
  gazeImpulse: { x: number; y: number }
  /** 光标：归一化 -1..1（窗口中心为原点）+ 活跃度 0..1 */
  cursor: { x: number; y: number; warm: number }
}

interface ManagedParam {
  value: number
  target: number
  speed: number
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
  private speakStrength = 0
  private thinkStrength = 0
  private gaze = { x: 0, y: 0 }
  private cursorWarm = 0
  private readonly walkers: Record<string, Walker>
  private readonly params = new Map<string, ManagedParam>()
  private readonly prevOwned = new Set<string>()
  private readonly blinkOwnedIds = new Set([EYE_L, EYE_R])

  constructor(core: Core) {
    // 头/身摆动游走器
    this.walkers = {
      angleX: createWalker(-SWAY_HEAD.angleX, SWAY_HEAD.angleX, [2500, 5000], 1.8),
      angleY: createWalker(-SWAY_HEAD.angleY, SWAY_HEAD.angleY, [2500, 5000], 1.8),
      angleZ: createWalker(-SWAY_HEAD.angleZ, SWAY_HEAD.angleZ, [3000, 6000], 1.8),
      bodyX: createWalker(-SWAY_BODY.x, SWAY_BODY.x, [4000, 7000], 1.2),
      bodyY: createWalker(-SWAY_BODY.y, SWAY_BODY.y, [4000, 7000], 1.2),
      bodyZ: createWalker(-SWAY_BODY.z, SWAY_BODY.z, [5000, 8000], 1.2)
    }

    // 注册受管参数（value 初始值会在首帧"未拥有"分支里从模型现值接管，无跳变）
    this.params.set(EYE_L, { value: 1, target: 1, speed: EYE_SPEED })
    this.params.set(EYE_R, { value: 1, target: 1, speed: EYE_SPEED })
    this.params.set(MOUTH, { value: 0, target: 0, speed: LIP_ATTACK })
    this.params.set(ANGLE_X, { value: 0, target: 0, speed: ANGLE_SPEED })
    this.params.set(ANGLE_Y, { value: 0, target: 0, speed: ANGLE_SPEED })
    this.params.set(ANGLE_Z, { value: 0, target: 0, speed: ANGLE_SPEED })
    this.params.set(BODY_X, { value: 0, target: 0, speed: BODY_SPEED })
    this.params.set(BODY_Y, { value: 0, target: 0, speed: BODY_SPEED })
    this.params.set(BODY_Z, { value: 0, target: 0, speed: BODY_SPEED })
    this.params.set(EYEBALL_X, { value: 0, target: 0, speed: GAZE_K })
    this.params.set(EYEBALL_Y, { value: 0, target: 0, speed: GAZE_K })
    // 瞬时参数：目标是加载时的中性快照（模型默认值）
    for (const id of TRANSIENT_IDS) {
      this.params.set(id, {
        value: core.getParameterValueById(id),
        target: core.getParameterValueById(id),
        speed: TAKE_OVER_K
      })
    }
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

  /** 每帧推进：合成目标 → 按所有权写参数 */
  update(input: ProceduralInput, core: Core, motionOwned: Set<string> | null): void {
    const { dt, t } = input
    this.updateBlink(dt)
    this.updateStrengths(input)
    this.composeTargets(input, t)

    for (const [id, p] of this.params.entries()) {
      const owned = motionOwned?.has(id) ?? false
      const ownedBefore = this.prevOwned.has(id)

      if (owned) {
        // 动作拥有该参数：程序层让位。两个特权例外——
        // 1) 说话时口型取 max：动作的嘴型曲线（如 surprise 张嘴）与语音口型并存
        if (id === MOUTH && this.lip > 0.02) {
          const motionMouth = core.getParameterValueById(MOUTH)
          if (this.lip > motionMouth) core.setParameterValueById(MOUTH, this.lip)
        }
        // 2) 眨眼瞬时覆盖（~140ms 窗口，可接受）
        if (this.blinkOwnedIds.has(id) && this.isBlinking) {
          core.setParameterValueById(id, this.blinkValue)
        }
        continue
      }

      // 刚失去所有权：从模型现值重播种，平滑回落无跳变
      if (ownedBefore) p.value = core.getParameterValueById(id)

      const speed = this.resolveSpeed(id, p)
      p.value = approach(p.value, p.target, speed, dt)
      const [lo, hi] = this.clampRange(id)
      core.setParameterValueById(id, clamp(p.value, lo, hi))
    }

    // 重建上一帧所有权集合
    this.prevOwned.clear()
    if (motionOwned) for (const id of motionOwned) this.prevOwned.add(id)
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
    this.cursorWarm = approach(
      this.cursorWarm,
      input.cursor.warm,
      CURSOR_DECAY,
      dt
    )
  }

  /** 合成各参数的目标值（游走器推进 + 姿态叠加） */
  private composeTargets(input: ProceduralInput, t: number): void {
    const s = this.speakStrength
    const th = this.thinkStrength
    const cw = this.cursorWarm

    // 1) 摆动游走器
    for (const w of Object.values(this.walkers)) {
      if (t >= w.nextAt) {
        w.nextAt = t + rand(w.intervalMs[0], w.intervalMs[1]) / 1000
        w.target = rand(w.min, w.max)
      }
      w.value = approach(w.value, w.target, w.k, input.dt)
    }
    const w = this.walkers

    // 2) 注视：thinking 看上方 / speaking 收敛中心 / idle 跟随脉冲
    const imp = input.gazeImpulse
    let gx = imp.x
    let gy = imp.y
    if (this.thinkStrength > 0.01) {
      gx = THINK_GAZE.x
      gy = THINK_GAZE.y
    } else if (s > 0.01) {
      gx = imp.x * SPEAK_GAZE_SHRINK
      gy = imp.y * SPEAK_GAZE_SHRINK
    }
    // 单位化（|目标|<0.01 特判为直视前方——规避原库 focus(0,0) 看向最右的 bug）
    const mag = Math.hypot(gx, gy)
    const unit = mag < 0.01 ? { x: 0, y: 0 } : { x: gx / mag, y: gy / mag }
    this.gaze = {
      x: approach(this.gaze.x, unit.x, GAZE_K, input.dt),
      y: approach(this.gaze.y, unit.y, GAZE_K, input.dt)
    }
    const p = this.params

    // 3) 头部：摆动 + 说话点头 + 思考仰头/侧倾 + 光标跟随 + 注视带动
    p.get(ANGLE_X)!.target =
      w.angleX!.value +
      this.gaze.y * GAZE_LEAN_PITCH +
      -input.cursor.y * CURSOR_PITCH * cw +
      Math.sin(t * Math.PI * 2 * SPEAK_NOD_HZ) * SPEAK_NOD_AMP * s +
      THINK_TILT_UP * th
    p.get(ANGLE_Y)!.target =
      w.angleY!.value +
      this.gaze.x * GAZE_LEAN_YAW +
      input.cursor.x * CURSOR_YAW * cw
    p.get(ANGLE_Z)!.target = w.angleZ!.value + THINK_TILT_Z * th

    // 4) 身体：独立慢摆 + 说话前倾 + 注视轻微带动
    p.get(BODY_X)!.target = w.bodyX!.value + SPEAK_LEAN * s + this.gaze.x * GAZE_LEAN_BODY
    p.get(BODY_Y)!.target = w.bodyY!.value
    p.get(BODY_Z)!.target = w.bodyZ!.value

    // 5) 眼睛：眨眼曲线 / 睁眼恢复
    const eyeTarget = this.isBlinking ? this.blinkValue : 1
    p.get(EYE_L)!.target = eyeTarget
    p.get(EYE_R)!.target = eyeTarget

    // 6) 眼球：注视合成直接驱动
    p.get(EYEBALL_X)!.target = this.gaze.x
    p.get(EYEBALL_Y)!.target = this.gaze.y

    // 7) 口型：非对称包络 + 语素抖动（三正弦不互质，说话时才有）
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
    p.get(MOUTH)!.target = this.lip > 0.01 ? this.lip * (0.8 + 0.4 * wobble) : 0
  }

  /** 每帧实际使用的平滑速率（口型开口快闭口慢） */
  private resolveSpeed(id: string, p: ManagedParam): number {
    if (id === MOUTH) return p.target > p.value ? LIP_ATTACK : LIP_RELEASE
    if (this.blinkOwnedIds.has(id) && this.isBlinking) return EYE_SPEED_BLINK
    return p.speed
  }

  /** 各参数的写入值域 */
  private clampRange(id: string): [number, number] {
    if (id === EYE_L || id === EYE_R || id === MOUTH) return [0, 1]
    if (id === EYEBALL_X || id === EYEBALL_Y) return [-1, 1]
    return [-30, 30]
  }
}
