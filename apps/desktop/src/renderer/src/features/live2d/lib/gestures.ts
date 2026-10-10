import type { Gesture } from '@pi-amadeus/shared'

/**
 * 程序手势：一组按时间的关键帧曲线，叠加在表情基线与待机摆动之上。
 *
 * 与 motion3 动作的区别：motion3 覆盖（拥有）参数，播放期间表情被冲掉；
 * 手势只做增量，表情、眨眼、口型、注视照常进行，可多个同时播放。
 * 坐标约定见 model-params.ts：x 画面右为 +、y 上为 +；yaw/pitch 写 Param14/15（大幅），
 * roll 写 ParamAngleZ。眼睛用"闭合量"（0 不变，1 全闭）与表情的开合相乘。
 */

export type GestureChannel =
  | 'yaw'
  | 'pitch'
  | 'roll'
  | 'bodyX'
  | 'bodyY'
  | 'bodyZ'
  | 'eyeCloseL'
  | 'eyeCloseR'
  | 'eyeX'
  | 'eyeY'
  | 'mouthOpen'
  | 'mouthForm'
  | 'breath'
  /** 整体缩放增量（0.05 = 放大 5%），表现凑近/后仰 */
  | 'zoom'
  /** 整体纵向位移（屏幕像素，+ 向下） */
  | 'lift'

export type GestureSample = Record<GestureChannel, number>

type Keys = ReadonlyArray<readonly [number, number]>

export interface GestureDef {
  channels: Partial<Record<GestureChannel, Keys>>
  /** 允许随机左右镜像（翻转 yaw/roll/eyeX/bodyX/bodyZ，交换左右眼） */
  mirror?: boolean
}

/** 内部手势 = 对外动作（shared Gesture，抱臂/放下除外，它们改的是持续姿态）+ 仅内部使用的几个 */
export type GestureName = Exclude<Gesture, 'crossarms' | 'uncross'> | 'yawn' | 'glance'

const GESTURE_DEFS: Record<GestureName, GestureDef> = {
  // 点头：两下，第二下更轻
  nod: {
    channels: {
      pitch: [[0, 0], [0.15, -12], [0.34, 2], [0.52, -7.5], [0.7, 0.5], [0.88, 0]]
    }
  },
  // 摇头：左右三下逐渐收小
  shake: {
    channels: {
      yaw: [[0, 0], [0.13, -12], [0.33, 11], [0.52, -8], [0.7, 4], [0.88, 0]]
    },
    mirror: true
  },
  // 歪头：侧倾并保持一会儿，眼睛略向上（roll 同时带动整体绕脖子转，见 procedural-layer）
  tilt: {
    channels: {
      roll: [[0, 0], [0.35, 20], [1.9, 18], [2.4, 0]],
      eyeY: [[0, 0], [0.35, 0.2], [1.9, 0.2], [2.4, 0]]
    },
    mirror: true
  },
  // 别过脸：转头 + 视线跟着躲开，略抬下巴
  lookaway: {
    channels: {
      yaw: [[0, 0], [0.3, -20], [2.0, -18], [2.6, 0]],
      pitch: [[0, 0], [0.3, 4], [2.0, 4], [2.6, 0]],
      eyeX: [[0, 0], [0.25, -0.8], [2.0, -0.7], [2.5, 0]]
    },
    mirror: true
  },
  // 哼！：闭眼甩头、抬下巴、撇嘴；头顶向转头的反侧倾（朝转头侧倾会像害羞耷拉）
  hmph: {
    channels: {
      yaw: [[0, 0], [0.18, -22], [1.6, -21], [2.1, 0]],
      pitch: [[0, 0], [0.18, 12], [1.6, 11], [2.1, 0]],
      roll: [[0, 0], [0.18, 8], [1.6, 7], [2.1, 0]],
      eyeCloseL: [[0, 0], [0.12, 1], [0.9, 1], [1.1, 0]],
      eyeCloseR: [[0, 0], [0.12, 1], [0.9, 1], [1.1, 0]],
      mouthForm: [[0, 0], [0.2, -0.6], [1.6, -0.6], [2.1, 0]]
    },
    mirror: true
  },
  // 叹气：先吸气微抬头，再垂头半闭眼呼气；呼气时胸口低于基线、整体略沉，有泄气感
  sigh: {
    channels: {
      pitch: [[0, 0], [0.5, 3], [1.1, -7], [1.9, -5], [2.4, 0]],
      eyeCloseL: [[0, 0], [0.5, 0.25], [1.1, 0.55], [1.9, 0.45], [2.4, 0]],
      eyeCloseR: [[0, 0], [0.5, 0.25], [1.1, 0.55], [1.9, 0.45], [2.4, 0]],
      breath: [[0, 0], [0.5, 0.75], [1.2, -0.25], [1.9, -0.2], [2.4, 0]],
      lift: [[0, 0], [0.5, 0], [1.2, 2.5], [1.9, 2], [2.4, 0]],
      mouthOpen: [[0, 0], [0.9, 0], [1.1, 0.14], [1.6, 0.1], [1.9, 0]]
    }
  },
  // 凑近：整体放大并略低头，像把脸凑过来
  lean: {
    channels: {
      zoom: [[0, 0], [0.4, 0.06], [2.2, 0.06], [2.8, 0]],
      lift: [[0, 0], [0.4, 14], [2.2, 14], [2.8, 0]],
      pitch: [[0, 0], [0.4, -3], [2.2, -3], [2.8, 0]]
    }
  },
  // 吓一跳：猛地后仰缩一下，身体抖动
  startle: {
    channels: {
      pitch: [[0, 0], [0.07, 10], [0.3, 7], [0.8, 0]],
      // zoom 以模型中心缩放会把脸往下拉，lift 要够大才能看到"往上一弹"
      zoom: [[0, 0], [0.07, -0.03], [0.35, -0.025], [0.9, 0]],
      lift: [[0, 0], [0.07, -16], [0.22, -12], [0.5, -2], [0.7, 1], [0.9, 0]],
      bodyZ: [[0, 0], [0.06, 2.5], [0.14, -2.5], [0.22, 1.2], [0.32, 0]]
    }
  },
  // 眨眼示意：单眼闭合 + 嘴角上扬 + 微歪头
  wink: {
    channels: {
      eyeCloseL: [[0, 0], [0.08, 1], [0.55, 1], [0.7, 0]],
      mouthForm: [[0, 0], [0.15, 0.6], [1.0, 0.6], [1.3, 0]],
      // 头歪向眨着的那只眼（画面左）
      roll: [[0, 0], [0.2, -10], [1.0, -10], [1.3, 0]]
    },
    mirror: true
  },
  // 翻白眼：视线绕上方划过，半闭眼
  eyeroll: {
    channels: {
      // 视线一段连续扫过上方（中间不设 0 关键帧，否则会"右、停、左"三段）
      eyeY: [[0, 0], [0.22, 0.9], [0.8, 0.9], [1.15, 0]],
      eyeX: [[0, 0], [0.22, 0.7], [0.8, -0.7], [1.15, 0]],
      // 翻眼时只压一点眼皮（半眯表情下压多了会像闭眼），回正时再压一下做出停顿
      eyeCloseL: [[0, 0], [0.22, 0.15], [0.8, 0.15], [1.05, 0.3], [1.5, 0]],
      eyeCloseR: [[0, 0], [0.22, 0.15], [0.8, 0.15], [1.05, 0.3], [1.5, 0]],
      pitch: [[0, 0], [0.3, 4], [0.85, 4], [1.25, 0]]
    },
    mirror: true
  },
  // 偷笑：闭眼抿嘴，头和肩小幅颠动
  giggle: {
    channels: {
      pitch: [[0, 0], [0.1, -4], [0.22, 0], [0.34, -4], [0.46, 0], [0.58, -3], [0.72, 0]],
      // 俯仰在本模型里位移很小，颠动主要靠上身下沉（bodyY 只有负值有效）
      bodyY: [[0, 0], [0.1, -1], [0.22, 0], [0.34, -1], [0.46, 0], [0.58, -0.7], [0.72, 0]],
      bodyZ: [[0, 0], [0.1, 0.8], [0.22, -0.8], [0.34, 0.8], [0.46, -0.8], [0.58, 0.5], [0.72, 0]],
      eyeCloseL: [[0, 0], [0.08, 0.9], [0.75, 0.9], [0.9, 0]],
      eyeCloseR: [[0, 0], [0.08, 0.9], [0.75, 0.9], [0.9, 0]],
      mouthForm: [[0, 0], [0.1, 0.7], [0.75, 0.7], [0.9, 0]]
    }
  },
  // 打哈欠：张大嘴、闭眼、仰头歪头
  yawn: {
    channels: {
      // mouthForm 负值让张嘴变成竖长的 O（0 时只是小圆口，像"哦"）
      mouthOpen: [[0, 0], [0.6, 0.9], [1.5, 1], [2, 0]],
      mouthForm: [[0, 0], [0.6, -0.4], [1.5, -0.4], [2, 0]],
      eyeCloseL: [[0, 0], [0.45, 1], [1.6, 1], [2.1, 0]],
      eyeCloseR: [[0, 0], [0.45, 1], [1.6, 1], [2.1, 0]],
      pitch: [[0, 0], [0.6, 10], [1.5, 10], [2, -2], [2.4, 0]],
      roll: [[0, 0], [0.6, 10], [1.5, 10], [2.2, 0]],
      breath: [[0, 0], [0.6, 1], [1.6, 0]],
      lift: [[0, 0], [0.6, -5], [1.5, -5], [2.1, 0]]
    },
    mirror: true
  },
  // 瞥一眼：视线快速移到一侧停留再回来
  glance: {
    channels: {
      eyeX: [[0, 0], [0.12, 0.9], [0.9, 0.9], [1.05, 0]],
      yaw: [[0, 0], [0.2, 4], [0.9, 4], [1.1, 0]]
    },
    mirror: true
  }
}

const CHANNELS: GestureChannel[] = [
  'yaw', 'pitch', 'roll', 'bodyX', 'bodyY', 'bodyZ', 'eyeCloseL', 'eyeCloseR',
  'eyeX', 'eyeY', 'mouthOpen', 'mouthForm', 'breath', 'zoom', 'lift'
]

const MIRRORED: ReadonlySet<GestureChannel> = new Set(['yaw', 'roll', 'eyeX', 'bodyX', 'bodyZ'])

/** 调试：读取手势定义表（调参脚本读取当前值） */
export function debugGestureDefs(): Readonly<Record<GestureName, GestureDef>> {
  return GESTURE_DEFS
}

/** 调试：临时覆盖一个手势定义（运行时调参，刷新页面即恢复） */
export function debugOverrideGesture(name: GestureName, def: GestureDef): void {
  GESTURE_DEFS[name] = def
}

export function emptySample(): GestureSample {
  const s = {} as GestureSample
  for (const c of CHANNELS) s[c] = 0
  return s
}

export function isGestureName(name: string): name is GestureName {
  return Object.prototype.hasOwnProperty.call(GESTURE_DEFS, name)
}

/** 关键帧求值：段内 smoothstep 缓动，首帧前取首值、末帧后取末值 */
function sampleKeys(keys: Keys, t: number): number {
  const first = keys[0]
  if (!first) return 0
  if (t <= first[0]) return first[1]
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!
    if (t <= b[0]) {
      const a = keys[i - 1]!
      const u = (t - a[0]) / (b[0] - a[0] || 1)
      const e = u * u * (3 - 2 * u)
      return a[1] + (b[1] - a[1]) * e
    }
  }
  return keys[keys.length - 1]![1]
}

function durationOf(def: GestureDef): number {
  let d = 0
  for (const keys of Object.values(def.channels)) {
    const last = keys?.[keys.length - 1]
    if (last && last[0] > d) d = last[0]
  }
  return d
}

interface ActiveGesture {
  name: GestureName
  def: GestureDef
  t: number
  duration: number
  sign: 1 | -1
  intensity: number
}

export class GesturePlayer {
  private active: ActiveGesture[] = []
  private readonly sample: GestureSample = emptySample()

  /** 播放手势；同名手势正在播时从头重播（不叠加两份） */
  play(name: GestureName, opts: { intensity?: number; mirror?: boolean } = {}): void {
    const def = GESTURE_DEFS[name]
    const mirrored = def.mirror ? (opts.mirror ?? Math.random() < 0.5) : false
    this.active = this.active.filter((g) => g.name !== name)
    this.active.push({
      name,
      def,
      t: 0,
      duration: durationOf(def),
      sign: mirrored ? -1 : 1,
      intensity: opts.intensity ?? 1
    })
  }

  isPlaying(name?: GestureName): boolean {
    return name ? this.active.some((g) => g.name === name) : this.active.length > 0
  }

  stop(): void {
    this.active = []
  }

  /** 推进时间并返回各通道的合成增量（多个手势相加） */
  update(dt: number): GestureSample {
    const s = this.sample
    for (const c of CHANNELS) s[c] = 0
    for (const g of this.active) {
      g.t += dt
      for (const [channel, keys] of Object.entries(g.def.channels) as Array<[GestureChannel, Keys]>) {
        let target = channel
        let v = sampleKeys(keys, g.t) * g.intensity
        if (g.sign < 0) {
          if (MIRRORED.has(channel)) v = -v
          else if (channel === 'eyeCloseL') target = 'eyeCloseR'
          else if (channel === 'eyeCloseR') target = 'eyeCloseL'
        }
        s[target] += v
      }
    }
    this.active = this.active.filter((g) => g.t < g.duration)
    return s
  }
}
