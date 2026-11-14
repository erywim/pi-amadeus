/**
 * 网页抓取契约回归（报告来源：本次 public URL / DNS rebinding / 解码修复）。
 * 回放：不可信 URL → DNS 全地址校验 → 固定解析结果 → 每跳重定向 → 有界读取/解码。
 * fetch、代理和 DNS 全部注入；不会打开 socket、访问外网或真实内网，也不使用用户数据库。
 * 用法：node scripts/e2e-fetch-contract.mjs（Node >= 22.19）。
 */
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { ReadableStream } from 'node:stream/web'
import { URL } from 'node:url'

const { Response } = globalThis
const originalFetch = globalThis.fetch
const originalLookup = dns.lookup
const key = Symbol.for('amadeus.fetch-contract')
const publicIp = '93.184.216.34'
const state = {
  routes: new Map(),
  dns: new Map(),
  requests: [],
  lookups: [],
  agents: [],
  proxyCalls: [],
  connections: []
}

function reset() {
  state.routes.clear()
  state.dns.clear()
  state.requests.length = 0
  state.lookups.length = 0
  state.agents.length = 0
  state.proxyCalls.length = 0
  state.connections.length = 0
}

function serve(url, response, addresses = [{ address: publicIp, family: 4 }]) {
  state.routes.set(url, response)
  state.dns.set(new URL(url).hostname, addresses)
}

function textResponse(text, contentType = 'text/plain; charset=utf-8', status = 200) {
  return new Response(text, { status, headers: { 'content-type': contentType } })
}

function lookupWith(lookup, hostname, options) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error)
      else resolve(options.all ? address : { address, family })
    })
  })
}

class MockAgent {
  constructor(options) {
    this.lookup = options?.connect?.lookup
    this.destroyed = false
    state.agents.push(this)
  }

  async destroy() {
    this.destroyed = true
  }
}

async function mockFetch(input, init = {}, depth = 0) {
  init.signal?.throwIfAborted()
  const url = String(input)
  state.requests.push({ url, init })
  const agent = init.dispatcher
  if (agent) {
    assert.equal(typeof agent.lookup, 'function', '公网连接必须携带固定的 lookup')
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
    // 模拟连接器多次查址；二次连接不能重新查询 DNS，且须兼容 all/family 两种调用。
    const all = await lookupWith(agent.lookup, hostname, { all: true, family: 0 })
    const first = await lookupWith(agent.lookup, hostname, { family: all[0].family })
    state.connections.push({ hostname, all, first })
  }
  const handler = state.routes.get(url)
  if (!handler) throw new Error(`未注入的请求（禁止真实联网）：${url}`)
  const response = typeof handler === 'function' ? await handler(init) : handler
  if ([301, 302, 303, 307, 308].includes(response.status) && (init.redirect ?? 'follow') === 'follow') {
    assert.ok(depth < 20, 'mock 重定向上限')
    const next = new URL(response.headers.get('location'), url).href
    await response.body?.cancel()
    return mockFetch(next, init, depth + 1)
  }
  return response
}

// 模块钩子只替换 net.ts 的 I/O 边界，生产代码不增加可绕过校验的测试开关。
globalThis[key] = {
  Agent: MockAgent,
  fetch: mockFetch,
  proxyFetch: (proxy) => {
    state.proxyCalls.push(proxy)
    return mockFetch
  }
}
const virtualModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const mockUndici = virtualModule(`const io = globalThis[Symbol.for('amadeus.fetch-contract')];
export const Agent = io.Agent; export const fetch = io.fetch;`)
const mockLlm = virtualModule(`export const proxyFetch = (...args) =>
  globalThis[Symbol.for('amadeus.fetch-contract')].proxyFetch(...args);`)
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/tools/net.ts')) {
      if (specifier === 'undici') return { url: mockUndici, shortCircuit: true }
      if (specifier === '../llm.ts') return { url: mockLlm, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
globalThis.fetch = mockFetch
dns.lookup = async (hostname, options) => {
  state.lookups.push({ hostname, options })
  assert.equal(options?.all, true, '必须检查 DNS 返回的全部地址')
  const answer = state.dns.get(hostname)
  if (typeof answer === 'function') return answer()
  if (answer) return answer
  throw Object.assign(new Error(`DNS mock: ${hostname}`), { code: 'ENOTFOUND' })
}
syncBuiltinESMExports()

let passed = 0
let failed = 0
async function check(name, test) {
  reset()
  try {
    await test()
    assert.ok(state.agents.every((agent) => agent.destroyed), '请求结束后必须释放 Agent')
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name} — ${error.message}`)
  }
}

try {
  const net = await import('../services/brain/src/tools/net.ts')
  const pages = await import('../services/brain/src/tools/fetchUrl.ts')
  const { knowledgeRoutes } = await import('../services/brain/src/routes/knowledge.ts')
  const page = (url, options) => {
    assert.equal(typeof pages.readPublicPage, 'function', '缺少共用的 readPublicPage 导出')
    return pages.readPublicPage(url, options)
  }
  const options = { publicOnly: true, timeoutMs: 1000 }
  const site = 'https://page.test/'

  await check('实体：越界/代理项/畸形数字不抛错，合法大写十六进制正常解码', async () => {
    assert.equal(
      net.decodeEntities('&#1114112; &#x110000; &#xD800; &#12ab; &#X1F600; &amp;'),
      '&#1114112; &#x110000; &#xD800; &#12ab; 😀 &'
    )
  })

  for (const address of [
    '0.0.0.0', '0.1.2.3', '10.1.2.3', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1',
    '240.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '[::]', '[::1]', '[fc00::1]', '[fe80::1]', '[ff02::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:93.184.216.34]',
    '[64:ff9b::7f00:1]', '[2002:7f00:1::]', '[2001:db8::1]', '[2001::1]', '[3fff::1]'
  ]) {
    await check(`publicOnly 拒绝非公网字面量 ${address}`, async () => {
      const url = `http://${address}/`
      serve(new URL(url).href, textResponse('不应读取'))
      await assert.rejects(net.fetchText(url, options), /公网|内网|本机/)
      assert.equal(state.requests.length, 0, '拒绝地址不能发起 fetch')
    })
  }

  for (const address of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://localhost./']) {
    await check(`拒绝规范化后的本机地址 ${address}`, async () => {
      serve(new URL(address).href, textResponse('不应读取'))
      await assert.rejects(net.fetchText(address, options), /公网|内网|本机/)
      assert.equal(state.requests.length, 0)
    })
  }

  await check('仅 http(s)，并拒绝 URL 内嵌凭证', async () => {
    await assert.rejects(net.fetchText('file:///etc/passwd', options), /http/)
    serve('https://user:secret@page.test/', textResponse('不应读取'))
    await assert.rejects(net.fetchText('https://user:secret@page.test/', options), /凭证|用户名|密码/)
    assert.equal(state.requests.length, 0)
  })

  for (const addresses of [
    [{ address: '10.0.0.8', family: 4 }],
    [{ address: publicIp, family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: publicIp, family: 4 }, { address: '::ffff:192.168.1.2', family: 6 }],
    [{ address: publicIp, family: 4 }, { address: 'fc00::8', family: 6 }],
    []
  ]) {
    await check(`DNS 全地址拒绝 ${JSON.stringify(addresses)}`, async () => {
      serve(site, textResponse('不应读取'), addresses)
      await assert.rejects(net.fetchText(site, options), /公网|内网|本机|解析/)
      assert.equal(state.requests.length, 0)
    })
  }

  await check('DNS 错误保留 code/cause，不当作空记录', async () => {
    const cause = Object.assign(new Error('dns unavailable'), { code: 'EAI_AGAIN' })
    state.dns.set('page.test', () => { throw cause })
    await assert.rejects(net.fetchText(site, options), (error) => {
      assert.match(error.message, /域名解析失败/)
      assert.match(error.message, /EAI_AGAIN/)
      assert.equal(error.cause, cause)
      return true
    })
    assert.equal(state.requests.length, 0)
  })

  await check('DNS rebinding：连接 lookup 固定到检查过的地址，保留 URL/Host', async () => {
    serve(site, textResponse('ok'))
    let resolutions = 0
    state.dns.set('page.test', () => [{ address: ++resolutions === 1 ? publicIp : '127.0.0.1', family: 4 }])
    const result = await net.fetchText(site, options)
    assert.equal(result.text, 'ok')
    assert.equal(resolutions, 1, '校验后不能二次解析')
    assert.equal(state.requests[0].url, site, '不能把 URL 换成 IP，破坏 TLS/Host')
    assert.equal(state.connections.length, 1)
    assert.deepEqual(state.connections[0].all, [{ address: publicIp, family: 4 }])
    assert.deepEqual(state.connections[0].first, { address: publicIp, family: 4 })
    await assert.rejects(lookupWith(state.agents[0].lookup, 'other.test', { all: true }), /域名|主机|hostname/i)
  })

  await check('原生公网 IPv6 与双栈 DNS 可以读取，连接只拿到已校验地址', async () => {
    const addresses = [{ address: publicIp, family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
    serve(site, textResponse('dual'), addresses)
    assert.equal((await net.fetchText(site, options)).text, 'dual')
    assert.deepEqual(state.connections[0].all, addresses)
    assert.deepEqual(await lookupWith(state.agents[0].lookup, 'page.test', { family: 6 }), addresses[1])
    const ipv6Url = 'https://[2606:4700:4700::1111]/'
    serve(ipv6Url, textResponse('v6'))
    assert.equal((await net.fetchText(ipv6Url, options)).text, 'v6')
    assert.equal(state.lookups.length, 1, 'IP 字面量不应再做 DNS 查询')
  })

  for (const status of [301, 302, 303, 307, 308]) {
    await check(`HTTP ${status} 每跳校验，禁止重定向到内网`, async () => {
      serve(site, new Response(null, { status, headers: { location: 'http://10.0.0.1/secret' } }))
      serve('http://10.0.0.1/secret', textResponse('不应读取'))
      await assert.rejects(net.fetchText(site, options), /公网|内网|本机/)
      assert.deepEqual(state.requests.map((request) => request.url), [site])
      assert.equal(state.requests[0].init.redirect, 'manual')
    })
  }

  await check('相对重定向与跨域重定向均重查 DNS，返回最终 URL', async () => {
    serve(site, new Response(null, { status: 302, headers: { location: '/next' } }))
    serve(`${site}next`, new Response(null, { status: 307, headers: { location: 'https://final.test/done' } }))
    serve('https://final.test/done', textResponse('<title>结束</title><p>正文</p>', 'text/html'))
    const result = await page(site)
    assert.equal(result.url, 'https://final.test/done')
    assert.equal(result.title, '结束')
    assert.equal(result.kind, 'html')
    assert.match(result.text, /正文/)
    assert.equal(state.lookups.length, 3)
  })

  await check('重定向目标的混合 DNS/非 HTTP 协议仍拒绝', async () => {
    serve(site, new Response(null, { status: 302, headers: { location: 'https://mixed.test/' } }))
    serve('https://mixed.test/', textResponse('不应读取'), [
      { address: publicIp, family: 4 }, { address: '::1', family: 6 }
    ])
    await assert.rejects(net.fetchText(site, options), /公网|内网|本机/)
    assert.equal(state.requests.length, 1)
    state.routes.set(site, new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }))
    await assert.rejects(net.fetchText(site, options), /http/)
    assert.equal(state.requests.length, 2)
  })

  await check('重定向环有上限，跨域不转发凭证头', async () => {
    serve(site, new Response(null, { status: 302, headers: { location: 'https://final.test/' } }))
    serve('https://final.test/', textResponse('done'))
    await net.fetchText(site, { ...options, headers: { Authorization: 'secret', Cookie: 'session', Accept: 'text/html' } })
    const headers = state.requests[1].init.headers
    assert.ok(!Object.keys(headers).some((header) => /^(authorization|cookie)$/i.test(header)))
    state.routes.set(site, new Response(null, { status: 302, headers: { location: site } }))
    await assert.rejects(net.fetchText(site, options), /重定向/)
    assert.ok(state.requests.length < 15, '不能无限跟随重定向')
  })

  await check('publicOnly + proxy fail closed，可信搜索端点仍能用本机/代理', async () => {
    serve(site, textResponse('public'))
    await assert.rejects(net.fetchText(site, { ...options, proxy: 'http://proxy.test:8080' }), /代理/)
    assert.equal(state.requests.length, 0)
    assert.equal(state.proxyCalls.length, 0)
    serve('http://127.0.0.1:9999/search', textResponse('trusted'))
    assert.equal((await net.fetchText('http://127.0.0.1:9999/search', { proxy: 'http://proxy.test:8080' })).text, 'trusted')
    assert.equal(state.lookups.length, 0)
    assert.equal(state.proxyCalls.length, 1)
  })

  await check('HTTP GBK charset 优先于 HTML meta，跨 chunk 字符不乱码', async () => {
    const bytes = Buffer.concat([
      Buffer.from('<meta charset="utf-8"><title>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from('</title><p>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</p>')
    ])
    serve(site, () => new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      }
    }), { headers: { 'content-type': 'text/html; charset="GBK"' } }))
    const result = await page(site)
    assert.equal(result.title, '中文')
    assert.ok(result.text.includes('中文') && !result.text.includes('�'))
  })

  for (const meta of ['<meta charset="gb2312">', '<meta content="text/html; charset=gbk" http-equiv="Content-Type">']) {
    await check(`HTML meta charset：${meta}`, async () => {
      const bytes = Buffer.concat([Buffer.from(`<!doctype html>${meta}<p>`), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</p>')])
      serve(site, new Response(bytes, { headers: { 'content-type': 'text/html' } }))
      assert.equal((await net.fetchText(site, options)).text.includes('中文'), true)
    })
  }

  await check('UTF-16 BOM 可读，未知 charset 不偷偷按 UTF-8 读乱码', async () => {
    serve(site, new Response(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文正文', 'utf16le')]), {
      headers: { 'content-type': 'text/plain' }
    }))
    assert.equal((await page(site)).text, '中文正文')
    state.routes.set(site, textResponse('text', 'text/plain; charset=not-a-real-encoding'))
    await assert.rejects(page(site), /编码|charset/i)
  })

  await check('有界读取：字节截断与字符截断分别保留标记，chars 不包含标记', async () => {
    serve(site, () => textResponse('1234567890'))
    let result = await page(site, { maxBytes: 8, maxChars: 100 })
    assert.equal(result.chars, 8)
    assert.equal(result.truncated, true)
    assert.match(result.text, /^12345678[\s\S]*截断/)
    result = await page(site, { maxBytes: 100, maxChars: 4 })
    assert.equal(result.chars, 10)
    assert.match(result.text, /^1234[\s\S]*截断/)
    result = await page(site, { maxBytes: 10, maxChars: 10 })
    assert.equal(result.truncated, false, '刚好达到字节上限不是截断')
  })

  await check('多字节字符被截在中间不输出替换乱码，正文最多读取 maxBytes', async () => {
    let cancelled = false
    let pulls = 0
    serve(site, () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(Buffer.from('中文'))
      },
      cancel() { cancelled = true }
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
    const result = await page(site, { maxBytes: 4 })
    assert.ok(cancelled)
    assert.equal(pulls, 1)
    assert.equal(result.chars, 1)
    assert.ok(result.text.startsWith('中'))
    assert.ok(!result.text.includes('�'))
    assert.equal(result.truncated, true)
  })

  await check('工具不会丢失底层字节截断标志（HTML 标签很多、可读正文很短）', async () => {
    serve(site, textResponse(`<html><body>short${'<i></i>'.repeat(430_000)}</body></html>`, 'text/html'))
    const tool = pages.createFetchUrlTool({})
    const result = await tool.execute('contract', { url: site })
    assert.equal(result.details.truncated, true)
    assert.match(result.content[0].text, /截断/)
    assert.ok(result.details.chars < 100)
  })

  for (const contentType of ['image/png', 'application/pdf', 'application/octet-stream', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    await check(`二进制 MIME 不读 body：${contentType}`, async () => {
      let reads = 0
      let cancels = 0
      serve(site, () => new Response(new ReadableStream({
        pull() { reads += 1; throw new Error('二进制 body 不应被读取') },
        cancel() { cancels += 1 }
      }, { highWaterMark: 0 }), { headers: { 'content-type': contentType } }))
      await assert.rejects(page(site), /二进制|内容类型/)
      assert.equal(reads, 0)
      assert.equal(cancels, 1)
    })
  }

  await check('缺失/谎报 MIME 的二进制通过魔数与控制字符拒绝，不返回乱码', async () => {
    for (const [bytes, type] of [
      [Buffer.from('%PDF-1.7\nnot text'), ''],
      [Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), 'text/plain'],
      [Buffer.from([0, 1, 2, 3]), 'text/html'],
      [Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]), 'text/plain; charset=utf-8']
    ]) {
      state.routes.set(site, new Response(bytes, { headers: type ? { 'content-type': type } : {} }))
      state.dns.set('page.test', [{ address: publicIp, family: 4 }])
      await assert.rejects(page(site), /二进制|内容类型|编码/)
    }
  })

  await check('JSON/无 MIME 的 HTML/空页面有稳定的共用返回字段', async () => {
    serve(site, textResponse('{"ok":true}', 'application/problem+json'))
    const json = await page(site)
    assert.deepEqual(Object.keys(json).sort(), ['url', 'title', 'contentType', 'text', 'chars', 'truncated', 'kind'].sort())
    assert.equal(json.kind, 'json')
    assert.equal(json.title, '')
    state.routes.set(site, new Response('<!doctype html><title>A &amp; B</title><p>Hello</p><script>secret()</script>'))
    const html = await page(site)
    assert.equal(html.kind, 'html')
    assert.equal(html.title, 'A & B')
    assert.ok(!html.text.includes('secret'))
    state.routes.set(site, new Response(null, { status: 204 }))
    assert.equal((await page(site)).kind, 'empty')
  })

  await check('fetch/body 错误都保留可读嵌套 cause 与原始 Error.cause', async () => {
    const cause = Object.assign(new Error('socket disappeared'), { code: 'ECONNRESET' })
    const failure = new Error('terminated', { cause })
    serve(site, () => new Response(new ReadableStream({
      pull(controller) { controller.error(failure) }
    }, { highWaterMark: 0 })))
    await assert.rejects(net.fetchText(site, options), (error) => {
      assert.match(error.message, /连接被重置/)
      assert.match(error.message, /ECONNRESET/)
      assert.match(error.message, /page\.test/)
      assert.equal(error.cause, failure)
      return true
    })
    state.routes.set(site, () => { throw failure })
    await assert.rejects(net.fetchText(site, options), (error) => error.cause === failure && /ECONNRESET/.test(error.message))
  })

  await check('AbortSignal：请求前、DNS 等待中、body 读取中都抛原 reason', async () => {
    const reason = { stopped: true }
    const before = new AbortController()
    before.abort(reason)
    await assert.rejects(net.fetchText(site, { ...options, signal: before.signal }), (error) => error === reason)
    assert.equal(state.requests.length, 0)
    const duringDns = new AbortController()
    state.dns.set('page.test', () => {
      duringDns.abort(reason)
      return new Promise(() => {})
    })
    await assert.rejects(net.fetchText(site, { ...options, signal: duringDns.signal }), (error) => error === reason)
    const duringBody = new AbortController()
    serve(site, () => new Response(new ReadableStream({
      pull(controller) {
        duringBody.abort(reason)
        controller.error(new Error('body error after abort'))
      }
    }, { highWaterMark: 0 })))
    await assert.rejects(net.fetchText(site, { ...options, signal: duringBody.signal }), (error) => error === reason)
  })

  await check('fetchJson 也保留 body cause/取消，并限制读取大小而非解析半截 JSON', async () => {
    const failure = new Error('terminated', { cause: Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }) })
    serve(site, () => new Response(new ReadableStream({ pull(controller) { controller.error(failure) } })))
    await assert.rejects(net.fetchJson(site), (error) => error.cause === failure && /UND_ERR_SOCKET/.test(error.message))
    state.routes.set(site, textResponse('{"value":"too long"}', 'application/json'))
    await assert.rejects(net.fetchJson(site, { maxBytes: 8 }), /过大|字节|截断/)
    const controller = new AbortController()
    const reason = new Error('stop-json')
    controller.abort(reason)
    await assert.rejects(net.fetchJson(site, { signal: controller.signal }), (error) => error === reason)
  })

  function knowledgeFixture() {
    const writes = []
    const db = {
      getKnowledgeBase: async () => ({ id: 'kb', userId: 'u', name: 'fixture' }),
      addKnowledgeDoc: async (input) => {
        writes.push(input)
        return { ...input, chars: input.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0), chunks: input.chunks.length, createdAt: 1 }
      }
    }
    const app = knowledgeRoutes(db)
    return {
      writes,
      request: (url) => app.request('/knowledge/kb/import-url?userId=u', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url })
      })
    }
  }

  await check('knowledge URL 导入使用同一公网策略，重定向内网不落库', async () => {
    serve(site, new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }))
    serve('http://127.0.0.1/secret', textResponse('不应导入'))
    const fixture = knowledgeFixture()
    const response = await fixture.request(site)
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /公网|内网|本机/)
    assert.equal(fixture.writes.length, 0)
    assert.equal(state.requests.length, 1)
  })

  await check('knowledge 二进制/截断明确拒绝，不把半篇文档落库', async () => {
    serve(site, new Response(Buffer.from([0, 1, 2]), { headers: { 'content-type': 'application/octet-stream' } }))
    const fixture = knowledgeFixture()
    let response = await fixture.request(site)
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /类型|二进制/)
    state.routes.set(site, textResponse('x'.repeat(1_600_001)))
    response = await fixture.request(site)
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /过大|截断/)
    assert.equal(fixture.writes.length, 0)
  })

  await check('knowledge 正常 HTML 导入共用解码/实体处理，最终 URL 作为来源', async () => {
    serve(site, new Response(null, { status: 302, headers: { location: 'https://final.test/article' } }))
    serve('https://final.test/article', textResponse('<p>safe &amp; &#x110000;</p><script>secret</script>', 'text/html'))
    const fixture = knowledgeFixture()
    const response = await fixture.request(site)
    assert.equal(response.status, 200)
    assert.equal(fixture.writes.length, 1)
    assert.equal(fixture.writes[0].source, 'https://final.test/article')
    assert.equal(fixture.writes[0].chunks[0].content, 'safe & &#x110000;')
  })
} finally {
  globalThis.fetch = originalFetch
  dns.lookup = originalLookup
  syncBuiltinESMExports()
  hook.deregister()
  delete globalThis[key]
}

console.log(`\nFetch contract: ${passed} passed, ${failed} failed; no real network or user data used.`)
if (failed) process.exitCode = 1
