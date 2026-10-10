import type { Emotion } from '@pi-amadeus/shared'
import type { GestureName } from './gestures'
import type { FaceKey } from './model-params'
import type { OverlayKind } from './overlays'

/**
 * 情绪配方：一个语义情绪 = 情绪脸 + 眼/嘴/视线 + 头部姿态 + 手臂 + 脸红 + 漫画符号 + 入场/待机手势。
 *
 * 坐标约定（与 gestures.ts 相同的观察者坐标）：x 画面右为 +、y 上为 +；
 * yaw/pitch 是 Param14/15 的偏移（大幅转头/俯仰），roll 是 ParamAngleZ 的偏移。
 * 数值经 scripts/live2d-shot.mjs 截图逐个调过，改动后请重新截图对比。
 */
export interface ExpressionRecipe {
  /** 情绪脸（六张脸不能混合，只选一张） */
  face?: FaceKey
  /** 情绪脸强度 0..1（中间值是表情形变的插值，可做"微怒""微笑"） */
  faceWeight?: number
  /** 眼睛开合 0..1（双眼）；eyeOpenL/R 单独覆盖（L 是画面左侧那只） */
  eyeOpen?: number
  eyeOpenL?: number
  eyeOpenR?: number
  /** 视线偏置 -1..1 */
  eyeX?: number
  eyeY?: number
  /** 嘴型 -1（撇嘴）..1（微笑） */
  mouthForm?: number
  /** 基础张嘴 0..1（说话口型在其上叠加） */
  mouthOpen?: number
  /** 头部姿态偏移（参数单位，约等于度） */
  yaw?: number
  pitch?: number
  roll?: number
  /** 手臂 0 垂下 .. 1 抱臂 */
  arms?: number
  /** 粉色脸红（两颊）0..1 */
  cheekBlush?: number
  /** "害羞"脸自带的橙色红晕 0..1（模型原值 0.09~0.8，0.8 过重） */
  shyBlush?: number
  /** 漫画符号 */
  overlays?: OverlayKind[]
  /** 切换到该情绪时播放的手势 */
  entry?: GestureName
  /** 保持该情绪、空闲时随机播放的手势 */
  idle?: GestureName[]
  /** 空闲时允许播放模型自带的随机动作（random1-5，会暂时覆盖眼/嘴/头） */
  randomMotions?: boolean
}

export interface ResolvedExpression {
  face: FaceKey | null
  faceWeight: number
  eyeOpenL: number
  eyeOpenR: number
  eyeX: number
  eyeY: number
  mouthForm: number
  mouthOpen: number
  yaw: number
  pitch: number
  roll: number
  arms: number
  cheekBlush: number
  shyBlush: number
  overlays: OverlayKind[]
  entry: GestureName | null
  idle: GestureName[]
  randomMotions: boolean
}

export const EXPRESSIONS: Record<Emotion, ExpressionRecipe> = {
  neutral: { arms: 1, idle: ['glance', 'tilt'], randomMotions: true },
  // 闭口微笑：开心脸满强度 + 眼睛略收
  smile: {
    face: 'joy',
    eyeOpen: 0.85,
    mouthForm: 1,
    mouthOpen: 0.05,
    arms: 1,
    entry: 'nod',
    idle: ['tilt', 'glance']
  },
  // 睁眼张口笑 + 淡脸红
  happy: {
    face: 'joy',
    mouthForm: 1,
    mouthOpen: 0.35,
    pitch: 2,
    arms: 0,
    cheekBlush: 0.15,
    entry: 'giggle',
    idle: ['giggle', 'tilt']
  },
  // ^^ 弯眼 + 张嘴笑
  laugh: {
    face: 'joy',
    eyeOpen: 0,
    mouthForm: 1,
    mouthOpen: 0.55,
    pitch: 3,
    arms: 0,
    cheekBlush: 0.2,
    entry: 'giggle',
    idle: ['giggle']
  },
  // 得意：怒脸压平的上眼睑 + 半眯眼 + 抿嘴笑 + 抬下巴（开心脸半眯会像犯困）
  smug: {
    face: 'angry',
    faceWeight: 0.5,
    eyeOpen: 0.65,
    mouthForm: 1,
    pitch: 8,
    roll: -5,
    arms: 1,
    entry: 'tilt',
    // 翻白眼表达不耐烦，会把得意演成 annoyed，待机用斜瞥
    idle: ['glance', 'tilt']
  },
  // 坏笑：不对称眯眼 + 嘴角上扬 + 歪头
  teasing: {
    face: 'joy',
    faceWeight: 0.6,
    eyeOpenL: 0.6,
    eyeOpenR: 0.85,
    mouthForm: 1,
    roll: 7,
    arms: 1,
    entry: 'wink',
    idle: ['wink', 'giggle']
  },
  excited: {
    face: 'surprised',
    faceWeight: 0.7,
    mouthForm: 0.9,
    mouthOpen: 0.3,
    arms: 0,
    cheekBlush: 0.15,
    overlays: ['sparkle'],
    entry: 'lean',
    idle: ['nod', 'tilt']
  },
  // 好奇：微微睁大眼、抬眼看人、双唇微启、歪头（不加脸红，避免与 excited 混）
  curious: {
    face: 'surprised',
    faceWeight: 0.5,
    eyeY: 0.15,
    mouthForm: 0.3,
    mouthOpen: 0.1,
    roll: 10,
    pitch: -3,
    arms: 0,
    entry: 'lean',
    idle: ['tilt', 'glance']
  },
  // 思考：轻度怒脸眯眼（专注）+ 视线右上 + 歪头
  thinking: {
    face: 'angry',
    faceWeight: 0.25,
    eyeOpen: 0.8,
    eyeX: 0.6,
    eyeY: 0.7,
    mouthForm: -0.15,
    roll: -8,
    pitch: 5,
    arms: 1,
    overlays: ['ellipsis'],
    entry: 'tilt',
    idle: ['tilt']
  },
  // 疑惑：单眼眯起（像挑眉）+ 撇嘴 + 歪头 + 问号
  confused: {
    face: 'surprised',
    faceWeight: 0.4,
    eyeOpenL: 0.75,
    eyeOpenR: 1,
    mouthForm: -0.4,
    roll: 12,
    arms: 1,
    overlays: ['question'],
    entry: 'tilt',
    idle: ['tilt']
  },
  surprised: {
    face: 'surprised',
    mouthForm: -0.2,
    mouthOpen: 0.45,
    arms: 0,
    overlays: ['exclaim'],
    entry: 'startle'
  },
  // 震惊：张大嘴 + 脸上竖线 + 冷汗
  shocked: {
    face: 'surprised',
    mouthForm: -0.8,
    mouthOpen: 1,
    pitch: 6,
    arms: 0,
    overlays: ['exclaim', 'sweat', 'gloom'],
    entry: 'startle'
  },
  // 害羞：Param3 脸自带的橙色红晕压到 0.2（原值 0.8 像"猴屁股"），以粉色脸红为主，垂眼躲开视线
  shy: {
    face: 'shy',
    shyBlush: 0.2,
    cheekBlush: 0.4,
    eyeOpen: 0.85,
    eyeX: -0.55,
    eyeY: -0.45,
    yaw: -10,
    pitch: -8,
    mouthForm: 0.25,
    arms: 0,
    entry: 'lookaway',
    idle: ['lookaway', 'glance']
  },
  flustered: {
    face: 'bashful',
    cheekBlush: 0.9,
    yaw: -14,
    pitch: -10,
    mouthForm: -0.2,
    mouthOpen: 0.2,
    arms: 0,
    overlays: ['steam', 'blushLines'],
    entry: 'shake',
    idle: ['shake', 'lookaway']
  },
  // 傲娇：脸红着怒视、别过脸、抱臂
  tsundere: {
    face: 'angry',
    faceWeight: 0.85,
    cheekBlush: 0.6,
    eyeX: -0.6,
    yaw: -16,
    pitch: 8,
    roll: 5,
    mouthForm: -0.7,
    arms: 1,
    overlays: ['blushLines'],
    entry: 'hmph',
    idle: ['hmph', 'lookaway']
  },
  annoyed: {
    face: 'angry',
    faceWeight: 0.7,
    eyeOpen: 0.72,
    mouthForm: -0.6,
    roll: -7,
    arms: 1,
    entry: 'sigh',
    idle: ['eyeroll', 'sigh']
  },
  // 生气：低头从刘海下瞪人 + 青筋
  angry: {
    face: 'angry',
    eyeOpen: 0.9,
    eyeY: 0.15,
    mouthForm: -1,
    mouthOpen: 0.1,
    pitch: -5,
    arms: 1,
    overlays: ['vein'],
    entry: 'shake',
    idle: ['hmph']
  },
  // 不屑：脸转开、抬下巴，眼睛从眼角斜着往下看人
  disdain: {
    face: 'angry',
    eyeOpen: 0.5,
    eyeX: -0.65,
    eyeY: -0.3,
    yaw: 8,
    pitch: 9,
    mouthForm: -0.15,
    arms: 1,
    entry: 'lookaway',
    idle: ['eyeroll']
  },
  // 难过：眼皮下垂看地面（与睁眼抬眼的 worried 拉开）
  sad: {
    face: 'sad',
    eyeOpen: 0.7,
    eyeY: -0.5,
    pitch: -10,
    mouthForm: -0.3,
    arms: 0,
    entry: 'sigh',
    idle: ['sigh']
  },
  crying: {
    face: 'sad',
    eyeOpen: 0.7,
    eyeY: -0.3,
    pitch: -8,
    mouthForm: -0.6,
    mouthOpen: 0.12,
    cheekBlush: 0.3,
    arms: 0,
    overlays: ['tears'],
    entry: 'sigh',
    idle: ['sigh']
  },
  gloomy: {
    face: 'sad',
    eyeOpen: 0.5,
    eyeY: -0.6,
    pitch: -16,
    mouthForm: -0.5,
    arms: 0,
    overlays: ['gloom'],
    entry: 'sigh',
    idle: ['sigh']
  },
  // 担心：难过脸满强度 + 抬眼看着对方 + 微张嘴
  worried: {
    face: 'sad',
    eyeY: 0.3,
    pitch: -4,
    mouthForm: -0.35,
    mouthOpen: 0.08,
    arms: 0,
    entry: 'lean',
    idle: ['tilt']
  },
  // 尴尬：八字眉苦笑 + 头和视线反向躲闪 + 冷汗
  nervous: {
    face: 'sad',
    faceWeight: 0.5,
    eyeOpen: 0.9,
    eyeX: -0.5,
    yaw: 7,
    mouthForm: 0.45,
    mouthOpen: 0.08,
    cheekBlush: 0.1,
    arms: 0,
    overlays: ['sweat'],
    entry: 'glance',
    idle: ['glance']
  },
  // 无语：面无表情的死鱼眼 + 冷汗
  speechless: {
    eyeOpen: 0.45,
    mouthForm: -0.05,
    arms: 1,
    overlays: ['ellipsis', 'sweat'],
    entry: 'eyeroll',
    idle: ['sigh', 'eyeroll']
  },
  sleepy: {
    eyeOpen: 0.25,
    pitch: -8,
    roll: 10,
    arms: 0,
    overlays: ['zzz'],
    entry: 'yawn',
    idle: ['yawn']
  }
}

/** 配方补全默认值（缺省 = 中性：无情绪脸、睁眼、抱臂、模型原始脸红） */
export function resolveRecipe(recipe: ExpressionRecipe): ResolvedExpression {
  const eyeOpen = recipe.eyeOpen ?? 1
  return {
    face: recipe.face ?? null,
    faceWeight: recipe.face ? (recipe.faceWeight ?? 1) : 0,
    eyeOpenL: recipe.eyeOpenL ?? eyeOpen,
    eyeOpenR: recipe.eyeOpenR ?? eyeOpen,
    eyeX: recipe.eyeX ?? 0,
    eyeY: recipe.eyeY ?? 0,
    mouthForm: recipe.mouthForm ?? 0,
    mouthOpen: recipe.mouthOpen ?? 0,
    yaw: recipe.yaw ?? 0,
    pitch: recipe.pitch ?? 0,
    roll: recipe.roll ?? 0,
    arms: recipe.arms ?? 1,
    cheekBlush: recipe.cheekBlush ?? 0,
    shyBlush: recipe.shyBlush ?? 0.09,
    overlays: recipe.overlays ?? [],
    entry: recipe.entry ?? null,
    idle: recipe.idle ?? [],
    randomMotions: recipe.randomMotions ?? false
  }
}

export function resolveExpression(emotion: Emotion): ResolvedExpression {
  return resolveRecipe(EXPRESSIONS[emotion])
}
