import type { PlatformInbound, PlatformStatus } from '@pi-amadeus/shared'

/** 适配器收到的上下文：平台记录 + 入站回调 */
export interface AdapterContext {
  platformId: string
  name: string
  config: Record<string, unknown>
  onMessage: (inbound: PlatformInbound) => void
}

export interface PlatformAdapter {
  start(): Promise<void>
  stop(): void
  send(chatId: string, chatType: 'private' | 'group', text: string): Promise<void>
  status(): PlatformStatus
}

/** 各平台单条消息的长度上限不同，统一按段发送（默认 4000，Telegram 4096） */
export function splitMessage(text: string, limit = 4000): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= limit) return [trimmed]
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > limit) {
    // 优先在换行/句号处切，找不到再硬切
    const slice = rest.slice(0, limit)
    const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'), slice.lastIndexOf('. '))
    const at = cut > limit * 0.6 ? cut + 1 : limit
    chunks.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

export function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}
