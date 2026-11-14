import { createHash } from 'node:crypto'
import type { PlatformMedia, PlatformStatus } from '@pi-amadeus/shared'
import {
  configString,
  splitMessage,
  type AdapterContext,
  type PlatformAdapter
} from './types.ts'

/** 公众号文本消息单条上限约 2048 字节，按 1800 字分段 */
const WECHAT_LIMIT = 1800

export interface WechatXml {
  [key: string]: string
}

/**
 * 微信公众号适配器（被动回调 + 客服消息）：
 * - 入站由 HTTP 回调交给 handleXml（签名在 manager 校验）
 * - 回合耗时超过被动回复窗口，所以统一返回 success 后用客服消息异步回复
 * - 图片/语音从微信媒体接口下载；语音优先用微信自带的 Recognition
 */
export class WechatAdapter implements PlatformAdapter {
  private state: PlatformStatus = { state: 'stopped' }
  private readonly ctx: AdapterContext
  private readonly token: string
  private readonly appId: string
  private readonly appSecret: string
  private readonly apiBaseUrl: string
  private accessTokenValue = ''
  private accessTokenExpiresAt = 0

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.token = configString(ctx.config, 'token')
    this.appId = configString(ctx.config, 'appId')
    this.appSecret = configString(ctx.config, 'appSecret')
    this.apiBaseUrl = (configString(ctx.config, 'apiBaseUrl') || 'https://api.weixin.qq.com').replace(
      /\/+$/,
      ''
    )
  }

  async start(): Promise<void> {
    if (!this.token) throw new Error('缺少回调签名 Token')
    if (!this.appId || !this.appSecret) throw new Error('缺少 AppID / AppSecret')
    await this.accessToken()
    this.state = { state: 'running', detail: `公众号 ${this.appId}`, since: Date.now() }
  }

  stop(): void {
    this.state = { state: 'stopped' }
  }

  status(): PlatformStatus {
    return this.state
  }

  async send(chatId: string, _chatType: 'private' | 'group', text: string): Promise<void> {
    // 公众号客服消息没有引用参数；文本分段发送
    for (const part of splitMessage(text, WECHAT_LIMIT)) {
      const token = await this.accessToken()
      const res = await fetch(`${this.apiBaseUrl}/cgi-bin/message/custom/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: chatId,
          msgtype: 'text',
          text: { content: part }
        }),
        signal: AbortSignal.timeout(20_000)
      })
      const json = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null
      if (!res.ok || (json?.errcode ?? 0) !== 0) {
        throw new Error(`微信发送失败：${json?.errmsg ?? `HTTP ${res.status}`}`)
      }
    }
  }

  /** 处理一条已通过签名校验的公众号 XML 消息 */
  async handleXml(xml: WechatXml): Promise<void> {
    const msgType = (xml.MsgType ?? '').toLowerCase()
    const from = xml.FromUserName ?? ''
    if (!from) return
    const media: PlatformMedia[] = []
    let text = ''

    if (msgType === 'text') {
      text = xml.Content ?? ''
    } else if (msgType === 'image') {
      const image = await this.downloadMedia(xml.MediaId, 'image/jpeg', 'image.jpg', xml.PicUrl)
      if (image) media.push(image)
    } else if (msgType === 'voice') {
      if (xml.Recognition) text = xml.Recognition
      const format = (xml.Format || 'amr').toLowerCase()
      const mime = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`
      const voice = await this.downloadMedia(xml.MediaId, mime, `voice.${format}`)
      if (voice) {
        if (text) {
          voice.name = '语音（已识别）'
          // 语音识别文本直接当正文，附件留档
        }
        media.push(voice)
      }
    } else if (msgType === 'event') {
      const event = (xml.Event ?? '').toLowerCase()
      if (event === 'subscribe') text = '用户刚关注了公众号，请简短打个招呼。'
      else return
    } else {
      return
    }

    if (!text.trim() && media.length === 0) return
    this.ctx.onMessage({
      externalUserId: from,
      chatId: from,
      chatType: 'private',
      text,
      messageId: xml.MsgId,
      media
    })
  }

  private async downloadMedia(
    mediaId: string | undefined,
    mimeType: string,
    name: string,
    directUrl?: string
  ): Promise<PlatformMedia | null> {
    try {
      let buffer: Buffer
      if (directUrl && /^https?:/i.test(directUrl)) {
        const res = await fetch(directUrl, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) return null
        buffer = Buffer.from(await res.arrayBuffer())
      } else if (mediaId) {
        const token = await this.accessToken()
        const res = await fetch(
          `${this.apiBaseUrl}/cgi-bin/media/get?access_token=${token}&media_id=${encodeURIComponent(mediaId)}`,
          { signal: AbortSignal.timeout(30_000) }
        )
        if (!res.ok) return null
        buffer = Buffer.from(await res.arrayBuffer())
      } else {
        return null
      }
      if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) return null
      return {
        kind: mimeType.startsWith('image/') ? 'image' : 'audio',
        name,
        mimeType,
        data: buffer.toString('base64'),
        size: buffer.length
      }
    } catch (error) {
      console.warn('[wechat] 媒体下载失败：', error instanceof Error ? error.message : error)
      return null
    }
  }

  private async accessToken(): Promise<string> {
    if (this.accessTokenValue && Date.now() < this.accessTokenExpiresAt) return this.accessTokenValue
    const url =
      `${this.apiBaseUrl}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(this.appId)}&secret=${encodeURIComponent(this.appSecret)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
      | null
    if (!res.ok || !json?.access_token) {
      throw new Error(`微信 access_token 获取失败：${json?.errmsg ?? `HTTP ${res.status}`}`)
    }
    this.accessTokenValue = json.access_token
    const expires = Number(json.expires_in ?? 7200)
    this.accessTokenExpiresAt = Date.now() + Math.max(60, expires - 120) * 1000
    return this.accessTokenValue
  }
}

/** 微信回调签名：sha1(sort(token, timestamp, nonce).join('')) */
export function verifyWechatSignature(
  token: string,
  timestamp: string,
  nonce: string,
  signature: string
): boolean {
  if (!token || !signature) return false
  const raw = [token, timestamp, nonce].sort().join('')
  return createHash('sha1').update(raw).digest('hex') === signature
}

/** 解析公众号回调的扁平 XML（字段要么 <Tag>值</Tag>，要么 CDATA） */
export function parseWechatXml(xml: string): WechatXml {
  const result: WechatXml = {}
  // 先剥掉 <xml> 根节点：否则首个匹配会把整段内容当作 xml 字段的值
  const withoutDeclaration = xml.replace(/<\?xml[^>]*\?>/i, '').trim()
  const inner = /^<xml>([\s\S]*)<\/xml>$/i.exec(withoutDeclaration)?.[1] ?? withoutDeclaration
  const regex = /<([A-Za-z0-9_]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/\1>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(inner)) !== null) {
    const key = match[1]!
    const value = (match[2] ?? match[3] ?? '').trim()
    result[key] = value
  }
  return result
}
