import type { Emotion } from '@pi-amadeus/shared'
import type { GestureName } from './gestures'

/**
 * 小表演：动作 × 表情。
 *
 * 只有动作没有脸的表演看起来是面无表情的——桌宠待机与戳一戳都从这里取组合。
 * 表情在动作结束（holdMs）后自动回落到 live2dStore 里的当前情绪；
 * 真实情绪事件或开始说话会提前打断（见 live2d-engine 的 endPerformance）。
 */
export interface Performance {
  emotion: Emotion
  /** 程序手势；省略表示播模型自带的随机动作（random1-5） */
  gesture?: GestureName
  /** 表情保持时长（毫秒），应覆盖动作本身的长度 */
  holdMs: number
}

/**
 * 待机表演池：模型自带动作与程序手势各占一半。
 *
 * random1-5 不驱动六张情绪脸（Param3-8，实测 motion3 曲线），所以动作期间换脸就是
 * 真正的"动作 × 表情"；但它们会驱动眼/嘴，因此只挑睁眼的情绪，
 * 避免"闭眼笑的脸 + 睁眼动画"这种互相打架的组合。
 */
export const IDLE_PERFORMANCES: readonly Performance[] = [
  // 模型自带动作（约 3 秒，表情多停一会儿）
  { emotion: 'smile', holdMs: 3400 },
  { emotion: 'happy', holdMs: 3400 },
  { emotion: 'curious', holdMs: 3400 },
  { emotion: 'surprised', holdMs: 3400 },
  { emotion: 'smug', holdMs: 3400 },
  { emotion: 'excited', holdMs: 3400 },
  // 程序手势（表情与手势一一对应）；害羞只在戳她时出现，不进待机池
  { emotion: 'smile', gesture: 'nod', holdMs: 2400 },
  { emotion: 'sleepy', gesture: 'yawn', holdMs: 3000 },
  { emotion: 'thinking', gesture: 'tilt', holdMs: 3000 },
  { emotion: 'teasing', gesture: 'wink', holdMs: 2400 },
  { emotion: 'annoyed', gesture: 'eyeroll', holdMs: 2400 }
]

/** 戳一戳的反应：沿用原来的动作池，给每个动作配一张脸；害羞只在这里出现 */
export const POKE_PERFORMANCES: readonly Performance[] = [
  { emotion: 'curious', gesture: 'tilt', holdMs: 2400 },
  { emotion: 'teasing', gesture: 'wink', holdMs: 2400 },
  { emotion: 'tsundere', gesture: 'hmph', holdMs: 2600 },
  { emotion: 'surprised', gesture: 'startle', holdMs: 2400 },
  { emotion: 'smile', gesture: 'nod', holdMs: 2400 },
  { emotion: 'shy', gesture: 'lookaway', holdMs: 3000 }
]

export function randomPerformance(pool: readonly Performance[]): Performance {
  return pool[Math.floor(Math.random() * pool.length)]!
}
