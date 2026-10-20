import { DRAWABLES, FACE_PARAMS, P, type FaceKey, type ParamKey } from './model-params'

/**
 * 可切换的 Live2D 模型档案。
 *
 * 程序层（表情/眨眼/口型/姿态）只认识通用参数键（ParamKey），
 * 每个模型在这里把自己的参数 ID 映射到这些键；没有的键保持 undefined，
 * 程序层就不注册、不写它——不同模型不会因为缺参数而把动画写坏。
 * 红莉栖私有的东西（六张情绪脸、脸红网格、漫画符号锚点）只在该档案里开启。
 *
 * 资源目录以 public/ 为根；modelUrl() 负责拼 BASE_URL（dev '/' / build './'）。
 */

export type Live2dModelId = 'kurisu' | 'mao_pro' | 'shizuku'

export interface ModelAvatar {
  scale: number
  positionX: number
  positionY: number
}

export interface ModelProfile {
  id: Live2dModelId
  label: string
  /** public 下的目录（含尾斜杠） */
  dir: string
  /** model3.json 文件名（原样，拼 URL 时编码） */
  file: string
  /** 通用参数键 → 该模型的参数 ID */
  params: Partial<Record<ParamKey, string>>
  /** 六张情绪脸（没有该体系的模型留空） */
  faceParams: Partial<Record<FaceKey, string>>
  /** 用参数直接驱动脸红（没有网格覆盖方案时） */
  blushParam?: string
  /** 红莉栖的网格锚点表；有它才启用脸红网格覆盖与漫画符号 */
  drawables?: typeof DRAWABLES
  /** 漫画符号层依赖红莉栖的网格锚点，其它模型关闭 */
  overlays: boolean
  /** 待机时可随机播放的模型自带动作 */
  idleMotions: ReadonlyArray<{ group: string; index: number }>
  /** 该模型首次使用时的默认摆位（各模型画布尺寸不同，分别保存） */
  defaultAvatar: ModelAvatar
}

const DEFAULT_AVATAR: ModelAvatar = { scale: 0.42, positionX: 0, positionY: 24 }

export const MODEL_PROFILES: Record<Live2dModelId, ModelProfile> = {
  kurisu: {
    id: 'kurisu',
    label: '牧濑红莉栖',
    dir: 'live2dmodels/steinsGateKurisuNew/',
    file: '红莉栖.model3.json',
    params: { ...P },
    faceParams: { ...FACE_PARAMS },
    drawables: DRAWABLES,
    overlays: true,
    idleMotions: [1, 2, 3, 4, 5].map((n) => ({ group: `random${n}`, index: 0 })),
    defaultAvatar: DEFAULT_AVATAR
  },
  mao_pro: {
    id: 'mao_pro',
    label: 'Mao Pro（Live2D 官方）',
    dir: 'live2dmodels/mao_pro/runtime/',
    file: 'mao_pro.model3.json',
    params: {
      angleX: 'ParamAngleX',
      angleY: 'ParamAngleY',
      angleZ: 'ParamAngleZ',
      bodyX: 'ParamBodyAngleX',
      bodyY: 'ParamBodyAngleY',
      bodyZ: 'ParamBodyAngleZ',
      breath: 'ParamBreath',
      eyeL: 'ParamEyeLOpen',
      eyeR: 'ParamEyeROpen',
      eyeBallX: 'ParamEyeBallX',
      eyeBallY: 'ParamEyeBallY',
      // Mao 没有 ParamMouthOpenY，口型用 model3.json 的 LipSync 组（ParamA 元音口型）
      mouthOpen: 'ParamA'
    },
    faceParams: {},
    blushParam: 'ParamCheek',
    overlays: false,
    idleMotions: [{ group: 'Idle', index: 0 }],
    // 画布 5800×8400（其它两个约 1400×1900 / 1280×1380），按窗口高度约 0.085 才装得下
    defaultAvatar: { scale: 0.085, positionX: 0, positionY: 24 }
  },
  shizuku: {
    id: 'shizuku',
    label: 'Shizuku（Live2D 官方）',
    dir: 'live2dmodels/shizuku/runtime/',
    file: 'shizuku.model3.json',
    params: {
      angleX: 'PARAM_ANGLE_X',
      angleY: 'PARAM_ANGLE_Y',
      angleZ: 'PARAM_ANGLE_Z',
      bodyX: 'PARAM_BODY_X',
      bodyY: 'PARAM_BODY_Y',
      bodyZ: 'PARAM_BODY_Z',
      breath: 'PARAM_BREATH',
      eyeL: 'PARAM_EYE_L_OPEN',
      eyeR: 'PARAM_EYE_R_OPEN',
      eyeBallX: 'PARAM_EYE_BALL_X',
      eyeBallY: 'PARAM_EYE_BALL_Y',
      mouthOpen: 'PARAM_MOUTH_OPEN_Y',
      mouthForm: 'PARAM_MOUTH_FORM'
    },
    faceParams: {},
    blushParam: 'PARAM_TERE',
    overlays: false,
    idleMotions: [{ group: 'Idle', index: 0 }],
    defaultAvatar: DEFAULT_AVATAR
  }
}

export const MODEL_IDS = Object.keys(MODEL_PROFILES) as Live2dModelId[]

export const DEFAULT_MODEL_ID: Live2dModelId = 'kurisu'

/** 持久化值可能是旧版本/手改的脏数据：不认识就回默认模型 */
export function resolveModelId(value: unknown): Live2dModelId {
  return typeof value === 'string' && value in MODEL_PROFILES ? (value as Live2dModelId) : DEFAULT_MODEL_ID
}

export function getModelProfile(id: unknown): ModelProfile {
  return MODEL_PROFILES[resolveModelId(id)]
}

export function modelUrl(profile: ModelProfile): string {
  return `${import.meta.env.BASE_URL}${profile.dir}${encodeURIComponent(profile.file)}`
}
