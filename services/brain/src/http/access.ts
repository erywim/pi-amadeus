import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { BrainConfig } from '../config.ts'

type AccessConfig = Pick<BrainConfig, 'port' | 'httpAccess'>

/** 只豁免已有平台校验的精确回调；legacy 飞书没有验签，不能匿名公网放行。 */
function isPublicCallback(method: string, path: string): boolean {
  if (/^\/api\/platforms\/[^/]+\/wechat$/.test(path)) return method === 'GET' || method === 'POST'
  return method === 'POST' && (
    /^\/api\/platforms\/[^/]+\/webhook$/.test(path) ||
    /^\/api\/automations\/[^/]+\/trigger$/.test(path)
  )
}

function isLoopback(address: string | undefined): boolean {
  const ip = address?.replace(/^::ffff:/i, '') ?? ''
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'))
}

function authority(value: string): string | null {
  if (value.includes('*')) return null
  try {
    const url = new URL(`http://${value}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    // 不做 DNS 解析，也不把十进制 IP、编码或后缀相似域名归一成可信本机 Host。
    return value.toLowerCase() === url.host ? url.host : null
  } catch {
    return null
  }
}

function matchesToken(header: string | undefined, token: string): boolean {
  if (!header || !token) return false
  const actual = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** 管理入口先拒绝请求，再处理 CORS；只收紧 CORS 响应头挡不住简单 POST 的副作用。 */
export function createHttpApp(cfg: AccessConfig): Hono<{ Bindings: Partial<HttpBindings> }> {
  const hosts = new Set(
    ['localhost', '127.0.0.1', '[::1]'].map((host) => new URL(`http://${host}:${cfg.port}`).host)
  )
  for (const host of cfg.httpAccess.allowedHosts) {
    const checked = authority(host)
    if (!checked) throw new Error(`BRAIN_ALLOWED_HOSTS 包含无效 Host: ${host}`)
    hosts.add(checked)
  }
  const origins = new Set(cfg.httpAccess.allowedOrigins)
  for (const origin of origins) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error(`BRAIN_ALLOWED_ORIGINS 必须是精确 http(s) Origin: ${origin}`)
    }
  }
  const managedCors = cors({
    origin: (origin) => origin,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
  })
  const app = new Hono<{ Bindings: Partial<HttpBindings> }>()
  app.use('/api/*', async (c, next) => {
    if (isPublicCallback(c.req.method, c.req.path)) return next()

    const host = authority(c.req.header('host') ?? new URL(c.req.url).host)
    if (!host || !hosts.has(host)) return c.json({ error: '管理 API 的 Host 不被允许' }, 403)

    // 只信 Node 连接的对端，绝不把可伪造的 Forwarded / X-Forwarded-* 当成本机身份。
    const local = isLoopback(c.env?.incoming?.socket.remoteAddress)
    const origin = c.req.header('origin')
    const trustedOrigin = origin !== undefined && origins.has(origin)
    const electronFile = local && cfg.httpAccess.allowFileOrigin &&
      /\bElectron\/\d/.test(c.req.header('user-agent') ?? '') &&
      (origin === 'null' || origin === undefined)
    if (origin !== undefined && !trustedOrigin && !electronFile) {
      return c.json({ error: '管理 API 的 Origin 不被允许' }, 403)
    }

    const site = c.req.header('sec-fetch-site')
    if (site === 'cross-site' || site === 'same-site') {
      let trustedResource = false
      if (origin === undefined && ['GET', 'HEAD'].includes(c.req.method)) {
        try {
          // Vite 跨端口媒体标签没有 Origin；仅接受来自已配置渲染源的 Referer。
          trustedResource = origins.has(new URL(c.req.header('referer') ?? '').origin)
        } catch {
          // 无来源或无法解析的来源不能扩大浏览器访问边界。
        }
      }
      if (!trustedOrigin && !electronFile && !trustedResource) {
        return c.json({ error: '不允许跨站访问管理 API' }, 403)
      }
    }

    const tokenAccepted = matchesToken(c.req.header('authorization'), cfg.httpAccess.adminToken)
    // 预检本身没有副作用也不带 Bearer；实际远端请求仍必须逐次校验密钥。
    const tokenPreflight = c.req.method === 'OPTIONS' && trustedOrigin &&
      cfg.httpAccess.adminToken.length > 0 &&
      (c.req.header('access-control-request-headers') ?? '').toLowerCase()
        .split(',').some((header) => header.trim() === 'authorization')
    if (!local && !tokenAccepted && !tokenPreflight) {
      return c.json({ error: '远端管理默认关闭；需要配置管理密钥并使用 Authorization Bearer' }, 403)
    }
    return managedCors(c, next)
  })
  return app
}
