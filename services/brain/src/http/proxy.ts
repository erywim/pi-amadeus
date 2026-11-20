import { ProxyAgent, fetch as undiciFetch } from 'undici'

/** 模型与工具共用的网络原语，不依赖模型 SDK、调度器或会话。 */
export function proxyFetch(proxy: string): typeof globalThis.fetch {
  const agent = new ProxyAgent(proxy)
  const f = (input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...(init ?? {}), dispatcher: agent })
  return f as unknown as typeof globalThis.fetch
}
