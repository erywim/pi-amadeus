/**
 * 红莉栖模型（steinsGateKurisuNew/红莉栖.moc3）的参数与网格事实表。
 *
 * 全部经渲染探针实测（scripts/live2d-shot.mjs），不要按 Live2D 标准参数的直觉改：
 * - 45 个参数里 15 个没有任何绑定（全部 ParamBrow*、ParamEyeL/RSmile、ParamCheek、
 *   Param17、ParamHairFront/Side/Back），写了也没有效果
 * - 眉毛画在六张情绪脸里，随 Param3-8 变化；两张脸同时为 1 时不会混合，只出现其中一张的关键形
 * - 方向（与标准一致，放大截图 + 像素测量确认）：ParamAngleX 小幅转头（+ 朝画面右）、
 *   ParamAngleY 俯仰（+ 抬头）、ParamAngleZ 歪头（+ 顺时针，幅度很小，±30 只转约 4°）；
 *   Param14 大幅转头（+ 朝画面右）、Param15 大幅俯仰（+ 抬头）；
 *   ParamEyeBallX + 看向画面右、ParamEyeBallY + 看向上方
 * - ParamEyeLOpen 是画面左侧那只眼睛
 */

export const P = {
  angleX: 'ParamAngleX',
  angleY: 'ParamAngleY',
  angleZ: 'ParamAngleZ',
  headYaw: 'Param14',
  headPitch: 'Param15',
  bodyX: 'ParamBodyAngleX',
  bodyY: 'ParamBodyAngleY',
  bodyZ: 'ParamBodyAngleZ',
  breath: 'ParamBreath',
  eyeL: 'ParamEyeLOpen',
  eyeR: 'ParamEyeROpen',
  eyeBallX: 'ParamEyeBallX',
  eyeBallY: 'ParamEyeBallY',
  mouthOpen: 'ParamMouthOpenY',
  mouthForm: 'ParamMouthForm',
  arms: 'Param16'
} as const

/** 程序层管理的通用参数键；各模型在 models.ts 里映射到自己的参数 ID，缺失的键不注册 */
export type ParamKey = keyof typeof P

/**
 * 方向符号：程序层统一用"画面右为 +x、上为 +y"的观察者坐标，
 * 写参数时乘以对应符号（实测方向见文件头）。
 */
export const SIGN = {
  angleX: 1,
  angleY: 1,
  headYaw: 1,
  headPitch: 1,
  eyeBallX: 1,
  eyeBallY: 1
} as const

/** 六张情绪脸（0..1）。名字按画面效果取，与 cdi3 里的中文名对应 */
export const FACE_PARAMS = {
  /** 害羞1：睁圆眼 + 大片橙色红晕（ArtMesh51/53） */
  shy: 'Param3',
  /** 开心：笑眼；配合闭眼是 ^^ 弯眼 */
  joy: 'Param4',
  /** 生气：怒视 */
  angry: 'Param5',
  /** 难过：八字眉、下垂眼 */
  sad: 'Param6',
  /** 娇羞：垂眼 + 八字眉 + 粉色脸红（lianhong/lianhong2） */
  bashful: 'Param7',
  /** 惊讶：瞪眼、眉毛上扬 */
  surprised: 'Param8'
} as const

export type FaceKey = keyof typeof FACE_PARAMS

export const FACE_KEYS = Object.keys(FACE_PARAMS) as FaceKey[]

/** 网格 ID（定位漫画符号、覆盖不透明度用） */
export const DRAWABLES = {
  /** 脸部皮肤（脸红的遮罩），定位脸的范围 */
  face: 'ArtMesh75',
  /** 头顶 */
  headTop: 'touding',
  /** 粉色脸红：画面左 / 右脸颊，原本只由 Param7 驱动 */
  cheekBlush: ['lianhong', 'lianhong2'],
  /** Param3 脸自带的橙色红晕（默认 0.09，Param3=1 时 0.8，过重） */
  shyBlush: ['ArtMesh51', 'ArtMesh53'],
  /** 画面左 / 右眼（与 ParamEyeLOpen / ParamEyeROpen 的绑定一致） */
  eyeL: ['ArtMesh52', 'ArtMesh54', 'ArtMesh55', 'ArtMesh56', 'ArtMesh57', 'ArtMesh62'],
  eyeR: ['ArtMesh88', 'ArtMesh89', 'ArtMesh90', 'ArtMesh91', 'ArtMesh92', 'ArtMesh95'],
  mouth: ['xiazui3', 'ArtMesh64']
} as const

/** Param3 脸红在模型里的原始基线不透明度（不做覆盖时的效果） */
export const SHY_BLUSH_BASE = 0.09
