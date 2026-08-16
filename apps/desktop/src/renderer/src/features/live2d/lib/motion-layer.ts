import type { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4'

/**
 * 动作层：管理 motion3 播放的"一遍即停"语义。
 *
 * 关键事实（pixi-live2d-display 0.4.0 源码行为，勿按直觉改动）：
 * - 本模型全部 15 个 motion3 的 Meta.Loop = true，动作永不自停；
 * - motion() 的 Promise 在动作**开始播放后立即 resolve**（不是播完），
 *   结束必须靠定时器 + stopAllMotions()（它同时重置 MotionState 优先级，
 *   否则 IDLE 动作在播过一次后会被永久拒绝——"待机动作只播一次"的现网 bug 根源）；
 * - 动作（无论自然结束还是被硬切）写入的参数值会**永久残留在模型里**：
 *   库只停动作、不回弹参数（官方 SDK 靠动作曲线自带"回到中性位"段，
 *   本模型 Loop=true 的曲线末帧未必是中性位）。残留的末帧姿势会成为
 *   下一个表情的"脏基线"——表情参数叠加其上，就是用户看到的怪异混合脸。
 *   因此 stop() 必须把全部参数恢复为模型默认值（Live2DCubismCore
 *   parameters.defaultValues），表情/程序层每帧在干净基线上叠加。
 *   程序层管理的参数（头/身/眼/口/眉）下一帧接管重播种，继续平滑过渡。
 */

interface MotionDataShape {
  duration?: number
  curves?: Array<{ id?: string }>
}

interface MotionRuntimeInfo {
  duration: number
  params: string[]
}

/** 静态兜底表：运行时读取 _motionData 失败时用（资产已实测解析，单位秒） */
const FALLBACK_DURATION: Record<string, number> = {
  neutral: 4.3,
  anger: 4.3,
  joy: 4.3,
  sadness: 4.3,
  shy: 3.333,
  shy2: 4.3,
  smile1: 4.3,
  smile2: 4.3,
  surprise: 3.333,
  unhappy: 4.3,
  random1: 3.0,
  random2: 3.0,
  random3: 3.0,
  random4: 3.0,
  random5: 3.0
}

/** 动作驱动参数集合兜底（随机动作为全身；情绪动作按实测并集取保守全量） */
const FALLBACK_PARAMS: Record<string, string[]> = {
  random1: [
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthForm', 'ParamMouthOpenY',
    'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamCheek'
  ],
  random2: [
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthForm', 'ParamMouthOpenY',
    'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamCheek'
  ],
  random3: [
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthForm', 'ParamMouthOpenY',
    'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamCheek'
  ],
  random4: [
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthForm', 'ParamMouthOpenY',
    'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamCheek'
  ],
  random5: [
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthForm', 'ParamMouthOpenY',
    'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamCheek'
  ],
  // 情绪动作公共集合（个别文件缺 ParamAngleZ / ParamEyeLSmile / ParamMouthOpenY，多登记无副作用）
  neutral: ['Param16'],
  anger: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param14', 'Param15', 'Param16', 'Param17'],
  joy: ['ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeLSmile', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param14', 'Param15'],
  sadness: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param14', 'Param15', 'Param17'],
  shy: ['ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param14', 'Param15'],
  shy2: ['ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param14', 'Param15'],
  smile1: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeLSmile', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param14', 'Param15'],
  smile2: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param14', 'Param15'],
  surprise: ['ParamAngleZ', 'ParamMouthForm', 'ParamMouthOpenY', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8', 'Param15'],
  unhappy: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8']
}

export interface ActiveMotion {
  /** 动作曲线驱动的参数集合——程序层对这些参数让位 */
  ownedParams: Set<string>
}

export class MotionLayer {
  private seq = 0
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private _active: ActiveMotion | null = null
  private destroyed = false

  constructor(private readonly model: Live2DModel) {}

  get active(): ActiveMotion | null {
    return this._active
  }

  get isPlaying(): boolean {
    return this._active !== null
  }

  /** 播放一遍（默认）。返回是否真正开始播放（被优先级拒绝时 false） */
  async play(
    group: string,
    index: number,
    priority: MotionPriority,
    loops = 1
  ): Promise<boolean> {
    if (this.destroyed) return false
    // 新动作前先复位旧动作残留：硬切时不把上一个动作的末帧姿势带进新动作
    this.stop()
    let started: boolean
    try {
      // 注意：此 Promise 在动作开始后立即 resolve，绝不能用它等动作结束
      started = await this.model.motion(group, index, priority)
    } catch {
      return false
    }
    if (!started || this.destroyed) return false

    const token = ++this.seq
    const info = this.readMotionInfo(group, index)
    this._active = { ownedParams: new Set(info.params) }
    // 到点硬停：Loop=true 的动作不自停；stopAllMotions 同时复位优先级。
    // 提前 50ms 停：落在曲线末帧（作者的回归位）而不是循环回卷后的开场帧
    this.endTimer = setTimeout(() => {
      if (token !== this.seq) return // 已被更新的动作取代
      this.stop()
    }, Math.max(0, info.duration * loops * 1000 - 50))
    return true
  }

  /** 硬停当前动作：先复位优先级，再把全部参数恢复为模型默认值（清除动作残留姿势） */
  stop(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer)
      this.endTimer = null
    }
    this.seq++
    this._active = null
    this.model.internalModel.motionManager.stopAllMotions()
    this.restoreParameters()
  }

  /**
   * 参数复位：Live2DCubismCore 提供 parameters.defaultValues（moc3 内置中性位）。
   * 程序层管理的参数（头/身/眼/口/眉）会在下一帧接管重播种，无视觉跳变；
   * 无人管理的情绪参数（Param3-8/16、ParamMouthForm 等）回到中性位，
   * 表情层每帧在干净基线上叠加，不再与动作残留混合。
   */
  private restoreParameters(): void {
    try {
      const core = this.model.internalModel.coreModel as unknown as {
        getModel?: () => { parameters?: { ids?: string[]; defaultValues?: Float32Array | number[] } } | null
        setParameterValueById?: (id: string, value: number) => void
      } | null
      const params = core?.getModel?.()?.parameters
      const ids = params?.ids
      const defaults = params?.defaultValues
      if (!core?.setParameterValueById || !ids || !defaults) return
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        const value = defaults[i]
        if (id === undefined || value === undefined) continue
        core.setParameterValueById(id, value)
      }
    } catch {
      // 复位失败不影响动作停止本身
    }
  }

  /** 运行时读取动作时长与驱动参数集合（types 公开字段）；失败走静态兜底表 */
  private readMotionInfo(group: string, index: number): MotionRuntimeInfo {
    const motion = this.model.internalModel.motionManager.motionGroups[group]?.[index]
    const data = (motion as unknown as { _motionData?: MotionDataShape } | null | undefined)
      ?._motionData
    if (data && typeof data.duration === 'number' && data.duration > 0) {
      return {
        duration: data.duration,
        params: (data.curves ?? []).map((c) => c.id ?? '').filter(Boolean)
      }
    }
    return {
      duration: FALLBACK_DURATION[group] ?? 3.0,
      params: FALLBACK_PARAMS[group] ?? []
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stop()
  }
}
