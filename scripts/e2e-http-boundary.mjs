/**
 * API 管理面边界回归（报告：全接口监听 + CORS * 让外站触发自定义 MCP）。
 * 用同一 HTTP app 工厂 + 无副作用探针回放请求，不导入 brain/index、不开用户数据库、不 spawn MCP。
 * app.request 注入 Node 对端元数据；再在随机 loopback 端口验证真实 Host / Origin / CORS。
 * 用法：node scripts/e2e-http-boundary.mjs（无需已运行的 brain / Electron / CDP）
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { loadConfig } from '../services/brain/src/config.ts'
import { createHttpApp } from '../services/brain/src/http/access.ts'

const require = createRequire(new URL('../services/brain/package.json', import.meta.url))
const { serve } = require('@hono/node-server')
const HOST = 'localhost:3002'
const DEV = 'http://localhost:5173'
const EVIL = 'https://evil.example'
const ELECTRON = 'Mozilla/5.0 Chrome/146.0.0.0 Electron/43.0.0'
const REMOTE = '203.0.113.9'
const securityKeys = [
  'BRAIN_HOST', 'BRAIN_ALLOWED_HOSTS', 'BRAIN_ALLOWED_ORIGINS',
  'BRAIN_ALLOW_FILE_ORIGIN', 'BRAIN_ADMIN_TOKEN', 'PORT'
]

function config(overrides = {}) {
  const saved = Object.fromEntries(securityKeys.map((key) => [key, process.env[key]]))
  try {
    for (const key of securityKeys) delete process.env[key]
    Object.assign(process.env, overrides)
    return loadConfig()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function probe(cfg) {
  const app = createHttpApp(cfg)
  let reached = 0
  app.all('/api/*', (c) => {
    reached++
    return c.json({ ok: true })
  })
  return { app, reached: () => reached }
}

let passed = 0
async function check(probeApp, label, { path = '/api/mcp/custom', method = 'POST', headers = {}, peer = '127.0.0.1', status = 200, cors = null, body } = {}) {
  const before = probeApp.reached()
  const res = await probeApp.app.request(`http://${HOST}${path}`, {
    method, headers: { host: HOST, ...headers }, ...(body !== undefined ? { body } : {})
  }, { incoming: { socket: { remoteAddress: peer } } })
  assert.equal(res.status, status, `${label}: HTTP status`)
  assert.equal(res.headers.get('access-control-allow-origin'), cors, `${label}: CORS`)
  assert.equal(probeApp.reached() - before, status === 200 ? 1 : 0, `${label}: 拒绝必须发生在处理器之前`)
  await res.text()
  passed++
}

const local = probe(config())
// 第一条也用于撤销修复后的红灯证明：旧 CORS * 会返回 200 并到达处理器。
await check(local, '恶意网站 JSON POST 不得到达 MCP', {
  headers: { origin: EVIL, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  body: '{"name":"boundary-probe","command":"not-executed"}', status: 403
})
await check(local, '恶意简单 POST 也要拒绝（不只是省略 CORS）', {
  headers: { origin: EVIL, 'content-type': 'text/plain' }, body: '{}', status: 403
})
await check(local, '恶意预检拒绝', {
  method: 'OPTIONS', headers: { origin: EVIL, 'access-control-request-method': 'POST' }, status: 403
})
await check(local, 'Vite JSON POST 无需 token', {
  headers: { origin: DEV, 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }, cors: DEV, body: '{}'
})
await check(local, '允许配置的 loopback 跨站来源', {
  headers: { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' }, cors: 'http://127.0.0.1:5173'
})
await check(local, 'Vite OPTIONS 不到达处理器', {
  method: 'OPTIONS', headers: { origin: DEV, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  status: 204, cors: DEV
})
await check(local, '本机无 Origin CLI', { method: 'GET', path: '/api/health' })
await check(local, 'IPv6 loopback', { peer: '::1', headers: { host: '[::1]:3002' } })
await check(local, 'IPv4-mapped IPv6 loopback', { peer: '::ffff:127.0.0.1' })
await check(local, '未知连接对端不能当本机', { peer: '', status: 403 })
for (const host of ['evil.example:3002', 'localhost.evil.example:3002', '127.0.0.1.evil.example:3002', 'localhost:9999', '2130706433:3002']) {
  await check(local, `DNS rebind / Host 不匹配 ${host}`, { headers: { host }, status: 403 })
}
for (const origin of ['http://localhost:5174', 'http://localhost:5173.evil.example', 'null']) {
  await check(local, `未允许浏览器 Origin ${origin}`, { headers: { origin }, status: 403 })
}
await check(local, '缺少 Origin 的跨站表单拒绝', {
  headers: { 'sec-fetch-site': 'cross-site', referer: `${EVIL}/` }, status: 403
})
await check(local, '缺少 Origin 的同站其他端口拒绝', {
  method: 'GET', headers: { 'sec-fetch-site': 'same-site', referer: 'http://localhost:9999/' }, status: 403
})
await check(local, 'Vite img 等无 Origin 资源读取保持可用', {
  method: 'GET', path: '/api/media/probe', headers: { 'sec-fetch-site': 'same-site', referer: `${DEV}/` }
})
await check(local, 'Referer 不能放行跨站写入', {
  headers: { 'sec-fetch-site': 'cross-site', referer: `${DEV}/` }, status: 403
})
await check(local, '打包 file Electron null Origin', {
  headers: { origin: 'null', 'user-agent': ELECTRON, 'sec-fetch-site': 'cross-site' }, cors: 'null'
})
await check(local, '打包 file Electron 无 Origin 资源', {
  method: 'GET', headers: { 'user-agent': ELECTRON, 'sec-fetch-site': 'cross-site' }
})
await check(local, 'Electron UA 不能信任任意 HTTPS 网站', {
  headers: { origin: EVIL, 'user-agent': ELECTRON }, status: 403
})
await check(probe(config({ BRAIN_ALLOW_FILE_ORIGIN: 'false' })), '可禁用 file 兼容', {
  headers: { origin: 'null', 'user-agent': ELECTRON }, status: 403
})
await check(local, '远端无 token 默认拒绝，即使 Host 是 localhost', { peer: REMOTE, status: 403 })
await check(local, 'XFF 不能伪装本机', {
  peer: REMOTE, headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1;host=localhost:3002' }, status: 403
})
const remoteConfig = config({
  BRAIN_HOST: '0.0.0.0', BRAIN_ALLOWED_HOSTS: 'brain.example:3002',
  BRAIN_ALLOWED_ORIGINS: `${DEV},https://console.example`, BRAIN_ADMIN_TOKEN: 'boundary-test-token'
})
const remote = probe(remoteConfig)
await check(remote, '显式公网监听仍禁止匿名管理', {
  peer: REMOTE, headers: { host: 'brain.example:3002' }, status: 403
})
await check(remote, '错误 Bearer 拒绝', {
  peer: REMOTE, headers: { authorization: 'Bearer wrong' }, status: 403
})
await check(remote, '显式 Bearer + Host 允许远端 CLI', {
  peer: REMOTE, headers: { host: 'brain.example:3002', authorization: 'Bearer boundary-test-token' }
})
await check(remote, '显式 Bearer + 配置 Origin 允许远端浏览器', {
  peer: REMOTE, headers: { host: 'brain.example:3002', origin: 'https://console.example', authorization: 'Bearer boundary-test-token', 'sec-fetch-site': 'cross-site' },
  cors: 'https://console.example'
})
await check(remote, '可信远端浏览器的 Bearer 预检', {
  peer: REMOTE, method: 'OPTIONS', headers: { host: 'brain.example:3002', origin: 'https://console.example',
    'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
  status: 204, cors: 'https://console.example'
})
await check(remote, '远端实际请求不因通过预检而匿名放行', {
  peer: REMOTE, headers: { origin: DEV }, status: 403
})
await check(remote, 'Bearer 不得绕过恶意 Origin', {
  peer: REMOTE, headers: { origin: EVIL, authorization: 'Bearer boundary-test-token' }, status: 403
})
await check(remote, 'Bearer 不得绕过 DNS rebind Host', {
  headers: { host: 'evil.example:3002', authorization: 'Bearer boundary-test-token' }, status: 403
})
await check(remote, 'Bearer 不得把远端 null Origin / Electron UA 当成本机', {
  peer: REMOTE, headers: { origin: 'null', 'user-agent': ELECTRON, authorization: 'Bearer boundary-test-token' }, status: 403
})
for (const [path, method] of [
  ['/api/platforms/probe/webhook', 'POST'], ['/api/platforms/probe/wechat', 'GET'],
  ['/api/platforms/probe/wechat', 'POST'], ['/api/automations/probe/trigger', 'POST']
]) {
  await check(local, `公开回调交给原有校验 ${method} ${path}`, {
    path, method, peer: REMOTE, headers: { host: 'callback.example', origin: EVIL }
  })
}
for (const [path, method] of [
  ['/api/platforms/probe/webhook', 'GET'], ['/api/platforms/probe/webhook', 'OPTIONS'],
  ['/api/platforms/probe/wechat', 'DELETE'], ['/api/automations/probe/trigger', 'GET'],
  ['/api/platforms/probe/webhook/extra', 'POST'], ['/api/platforms/probe/test', 'POST'],
  ['/api/mcp/custom/webhook', 'POST'], ['/api/feishu/webhook', 'POST']
]) {
  await check(local, `回调近似路径/管理操作不豁免 ${method} ${path}`, { path, method, peer: REMOTE, status: 403 })
}
await check(local, 'legacy 飞书本机保持原入口', { path: '/api/feishu/webhook' })
await check(remote, 'legacy 飞书远端可显式 Bearer 鉴权但不匿名', {
  path: '/api/feishu/webhook', peer: REMOTE, headers: { authorization: 'Bearer boundary-test-token' }
})
assert.equal(config().host, '127.0.0.1')
assert.equal(remoteConfig.host, '0.0.0.0')
assert.equal(remoteConfig.httpAccess.adminToken, 'boundary-test-token')
assert.deepEqual(remoteConfig.httpAccess.allowedOrigins, [DEV, 'https://console.example'])
assert.equal(config({ BRAIN_HOST: '::1' }).host, '::1')
for (const bad of [{ BRAIN_ALLOWED_HOSTS: '*' }, { BRAIN_ALLOWED_ORIGINS: '*' }, { BRAIN_ALLOWED_ORIGINS: 'null' }, { BRAIN_ALLOWED_ORIGINS: `${DEV}/path` }]) {
  assert.throws(() => createHttpApp(config(bad)))
}
// 校验真实入口仍调用同一工厂，并且把默认 host 传入监听器；不导入有启动副作用的 index。
const entry = readFileSync(new URL('../services/brain/src/index.ts', import.meta.url), 'utf8')
assert.match(entry, /createHttpApp\(cfg\)/)
assert.match(entry, /serve\(\{[^}]*hostname:\s*cfg\.host/s)
passed++

function httpRequest(port, path, headers, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
      res.on('error', reject)
    })
    req.setTimeout(3000, () => req.destroy(new Error('HTTP probe timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

// 从无监听进入临时 loopback 监听；端口随机且不复用用户的 brain 服务。
const live = probe(config())
const server = serve({ fetch: live.app.fetch, hostname: config().host, port: 0 })
try {
  await once(server, 'listening')
  const address = server.address()
  assert.equal(address.address, '127.0.0.1')
  const ok = await httpRequest(address.port, '/api/health', { host: HOST, origin: DEV })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['access-control-allow-origin'], DEV)
  const before = live.reached()
  for (const headers of [
    { host: HOST, origin: EVIL, 'content-type': 'text/plain' },
    { host: 'rebind.example:3002', origin: DEV },
    { host: HOST, origin: 'null', 'user-agent': 'Mozilla/5.0 Chrome/146.0.0.0' },
    { host: HOST, 'sec-fetch-site': 'cross-site' }
  ]) {
    const res = await httpRequest(address.port, '/api/mcp/custom', headers, 'POST', '{}')
    assert.equal(res.status, 403)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  }
  assert.equal(live.reached(), before, '真实 HTTP 拒绝请求不能触达处理器')
  const preflight = await httpRequest(address.port, '/api/mcp/custom', {
    host: HOST, origin: DEV, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'
  }, 'OPTIONS')
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], DEV)
  assert.equal(preflight.headers['access-control-allow-headers'], 'Content-Type,Authorization')
  const file = await httpRequest(address.port, '/api/health', { host: HOST, origin: 'null', 'user-agent': ELECTRON })
  assert.equal(file.status, 200)
  assert.equal(file.headers['access-control-allow-origin'], 'null')
  passed += 8
} finally {
  // 测试完成或断言失败都从监听转为关闭，不留服务/连接给下一次回归。
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
console.log(`HTTP boundary: ${passed} checks passed (app.request + temporary loopback HTTP; no DB / MCP side effects)`)
