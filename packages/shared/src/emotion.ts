/**
 * Live2D 情绪与动作词汇——大脑（LLM 提示词、解析器）与渲染端（表情配方）共用。
 *
 * 情绪是"持续状态"：决定脸、眼、嘴、姿态、脸红与漫画符号，直到下一个情绪或空闲回落；
 * 动作是"一次性事件"：点头、摇头、歪头……播完回到当前情绪的姿态。
 * 名字是语义名，与模型资产文件名解耦——一个情绪由渲染端配方组合多个参数实现。
 */

export const EMOTIONS = [
  'neutral',
  'smile',
  'happy',
  'laugh',
  'smug',
  'teasing',
  'excited',
  'curious',
  'thinking',
  'confused',
  'surprised',
  'shocked',
  'shy',
  'flustered',
  'tsundere',
  'annoyed',
  'angry',
  'disdain',
  'sad',
  'crying',
  'gloomy',
  'worried',
  'nervous',
  'speechless',
  'sleepy'
] as const

export type Emotion = (typeof EMOTIONS)[number]

/** 情绪的中文含义：写进 LLM 提示词，也用于界面预览 */
export const EMOTION_LABELS: Record<Emotion, string> = {
  neutral: '平静',
  smile: '微笑',
  happy: '开心',
  laugh: '大笑',
  smug: '得意',
  teasing: '坏笑、调侃',
  excited: '兴奋，聊到感兴趣的科学话题时',
  curious: '好奇、感兴趣',
  thinking: '思考',
  confused: '疑惑',
  surprised: '惊讶',
  shocked: '震惊、吓一跳',
  shy: '害羞',
  flustered: '慌乱、脸红到冒烟',
  tsundere: '傲娇、恼羞成怒，"才、才不是呢！"',
  annoyed: '不耐烦',
  angry: '生气',
  disdain: '不屑、看不起',
  sad: '难过',
  crying: '哭泣、委屈',
  gloomy: '沮丧、郁闷',
  worried: '担心',
  nervous: '尴尬、冒汗',
  speechless: '无语',
  sleepy: '困倦'
}

/**
 * 旧版情绪名（= 模型表情资产名）→ 语义情绪。
 * 用户自定义提示词或历史数据里仍可能出现，解析时一并接受。
 */
const LEGACY_EMOTIONS: Record<string, Emotion> = {
  joy: 'happy',
  sadness: 'sad',
  anger: 'angry',
  surprise: 'surprised',
  shy2: 'flustered',
  smile1: 'smile',
  smile2: 'happy',
  unhappy: 'sad'
}

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && (EMOTIONS as readonly string[]).includes(value)
}

/** 解析 LLM 输出的情绪名：大小写/空白容错，兼容旧名；无法识别返回 null */
export function normalizeEmotion(value: unknown): Emotion | null {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  if (isEmotion(name)) return name
  return LEGACY_EMOTIONS[name] ?? null
}

export const GESTURES = [
  'nod',
  'shake',
  'tilt',
  'lookaway',
  'hmph',
  'sigh',
  'lean',
  'startle',
  'wink',
  'eyeroll',
  'giggle',
  'crossarms',
  'uncross'
] as const

export type Gesture = (typeof GESTURES)[number]

export const GESTURE_LABELS: Record<Gesture, string> = {
  nod: '点头',
  shake: '摇头',
  tilt: '歪头',
  lookaway: '别过脸',
  hmph: '"哼"地甩头',
  sigh: '叹气',
  lean: '凑近',
  startle: '吓一跳',
  wink: '眨眼示意',
  eyeroll: '翻白眼',
  giggle: '偷笑',
  crossarms: '抱起双臂',
  uncross: '放下双臂'
}

export function isGesture(value: unknown): value is Gesture {
  return typeof value === 'string' && (GESTURES as readonly string[]).includes(value)
}

/** 解析 LLM 输出的动作名：大小写/空白容错；无法识别返回 null */
export function normalizeGesture(value: unknown): Gesture | null {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  return isGesture(name) ? name : null
}
