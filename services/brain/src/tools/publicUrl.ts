import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'

/** 仅放行可全局路由的单播地址；映射/转换 IPv6 不作为绕过 IPv4 校验的入口。 */
function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false
  const [left = '', right] = address.toLowerCase().split('::')
  const head = left ? left.split(':') : []
  const tail = right ? right.split(':') : []
  const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  const value = BigInt(`0x${groups.map((part) => part.padStart(4, '0')).join('')}`)
  // 只接受 2000::/3；排除 IETF 特殊分配、文档网段与 6to4（可内嵌私有 IPv4）。
  return value >> 125n === 1n && ![
    [0x20010000000000000000000000000000n, 23n],
    [0x20010db8000000000000000000000000n, 32n],
    [0x20020000000000000000000000000000n, 16n],
    [0x3fff0000000000000000000000000000n, 20n]
  ].some(([prefix = 0n, bits = 0n]) => value >> (128n - bits) === prefix >> (128n - bits))
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/** 同步检查只用于语法/字面地址；实际请求还必须 resolvePublicUrl，不能仅靠此函数防 SSRF。 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new Error('不是合法 URL', { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http(s) 地址（收到 ${url.protocol}）`)
  }
  if (url.username || url.password) throw new Error('公网网页地址不得包含用户名/密码凭证')
  const hostname = hostnameOf(url)
  if (/(^|\.)localhost\.?$/i.test(hostname) || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new Error(`拒绝访问非公网/本机/内网地址：${hostname}`)
  }
  return url
}

/** DNS 本身不可取消；等待可以取消，迟到的解析结果不再触发请求。 */
export function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', abort, { once: true })
    // 即使调用 pending 的同一步触发了取消，也必须消费其 rejection，不能留下未处理的 body 错误。
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** 每跳解析全部地址，并返回只查已验证快照的 lookup，防止检查后再次解析造成 DNS rebinding。 */
export async function resolvePublicUrl(url: URL, signal: AbortSignal): Promise<LookupFunction> {
  const hostname = hostnameOf(url)
  const literalFamily = isIP(hostname)
  const records: LookupAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await withAbort(lookup(hostname, { all: true, verbatim: true }), signal)
  signal.throwIfAborted()
  if (!records.length) throw new Error(`域名解析未返回公网地址：${hostname}`)
  if (records.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
    throw new Error(`拒绝访问非公网/本机/内网 DNS 地址：${hostname}`)
  }
  const pinned = records.map(({ address, family }) => ({ address, family }))
  return (name, options, callback): void => {
    if (name.replace(/^\[|\]$/g, '').toLowerCase() !== hostname) {
      callback(new Error('固定解析结果的主机名不匹配'), '')
      return
    }
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
    const matches = pinned.filter((record) => !family || record.family === family)
    const first = matches[0]
    if (!first) {
      callback(new Error(`没有已验证的 IPv${family} 公网地址`), '')
      return
    }
    callback(null, options.all ? matches.map((record) => ({ ...record })) : first.address, first.family)
  }
}
