import type { Emotion } from './emotion.ts'

/**
 * 主动问候的跨端契约。
 *
 * 链路：桌面主进程截屏（后台 / 桌宠时每 10~15 分钟）→ 大脑 `POST /api/proactive`
 * （截图交视觉模型，产出 1~2 句中文并落库成助手消息）→ 主进程弹系统通知，
 * 同时把这条问候推给渲染层（桌宠对话框 / 陪伴页）。
 *
 * 截图只用于这一次请求，不落库、不写日志；问候正文是唯一持久化的内容。
 */
export interface ProactiveGreeting {
  /** 问候落库的会话（服务端选中的活动会话或新建会话） */
  sessionId: string
  messageId: string
  /** 中文问候正文（已剔除情绪标记；空正文不会成为一次成功问候） */
  text: string
  /** LLM 给出的情绪（可空）：桌宠窗口据此切表情 */
  emotion: Emotion | null
  createdAt: number
}

/** 主进程 → 渲染层的推送：问候 + 触发它时的窗口模式 */
export interface ProactiveMessageEvent extends ProactiveGreeting {
  /** 问候投递时应用所处的模式（window=主窗口在后台；pet=桌宠模式） */
  mode: 'window' | 'pet'
}
