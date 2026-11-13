/**
 * 通讯平台适配器（参考常见的多平台接入）：
 * 一个平台 = 一种外部消息通道 + 一份连接配置。所有平台共用同一套
 * 「绑定用户 → 共享会话 → agent 回合 → 回复」管线，桌面端能在会话列表里看到并继续。
 */

export type PlatformKind =
  | 'telegram'
  | 'onebot'
  | 'webhook'
  | 'discord'
  | 'slack'
  | 'wechat'
  | 'qqbot'

export type PlatformState = 'running' | 'stopped' | 'error'

export interface PlatformStatus {
  state: PlatformState
  /** 运行中的补充信息（bot 用户名、连接地址等）或错误原因 */
  detail?: string
  since?: number
}

export interface PlatformItem {
  id: string
  kind: PlatformKind
  name: string
  enabled: boolean
  /**
   * 配置。密钥类字段永远不回传原值：
   * telegram: { baseUrl, testChatId, tokenSet }
   * onebot:  { url, testChatId, accessTokenSet }
   * webhook: { outboundUrl, secretSet }
   * discord: { testChannelId, botTokenSet, gatewayUrl? }
   * slack:   { testChannelId, botTokenSet, appTokenSet }
   */
  config: Record<string, unknown>
  status: PlatformStatus
  createdAt: number
  updatedAt: number
}

export interface PlatformInput {
  kind: PlatformKind
  name: string
  enabled?: boolean
  /**
   * 明文配置。密钥字段留空表示「保持已保存的值」。
   * telegram: { token?, baseUrl?, testChatId? }
   * onebot:  { url?, accessToken?, testChatId? }
   * webhook: { outboundUrl?, secret? }
   * discord: { botToken?, gatewayUrl?, apiBaseUrl?, testChannelId? }
   * slack:   { botToken?, appToken?, apiBaseUrl?, testChannelId? }
   */
  config: Record<string, string>
}

/** 平台附件：适配器下载/解码后交给管线（base64，无 data: 前缀） */
export interface PlatformMedia {
  kind: 'image' | 'audio' | 'file'
  name: string
  mimeType: string
  data: string
  size?: number
}

/** 平台入站消息（适配器解析后交给共用管线） */
export interface PlatformInbound {
  externalUserId: string
  chatId: string
  chatType: 'private' | 'group'
  /** 纯文本；可能为空（只发了图片/语音/文件） */
  text: string
  /** 平台消息 id：用于被动回复 / 引用 */
  messageId?: string
  /** 被引用消息的文本（能拿到时） */
  quote?: string
  /** 图片 / 语音 / 文件 */
  media?: PlatformMedia[]
}
