/**
 * Live2D 表情枚举——与模型资产 `红莉栖.model3.json` 的 Expression 条目
 * （即 10 个 .exp3.json 文件名）一一对应。名字即资产名，不可随意改。
 */
export const EMOTIONS = [
  'anger',
  'joy',
  'neutral',
  'sadness',
  'shy',
  'shy2',
  'smile1',
  'smile2',
  'surprise',
  'unhappy'
] as const

export type Emotion = (typeof EMOTIONS)[number]

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && (EMOTIONS as readonly string[]).includes(value)
}
