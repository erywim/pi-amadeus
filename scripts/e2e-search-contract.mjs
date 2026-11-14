/**
 * PIAM-1 联网搜索回归：原始故障是网络搜索失败；旧代码把故障当成零命中成功，
 * 严格字符串切 HTML，删掉所有查询参数去重。所有请求只到脚本自建的环回服务，
 * 不依赖模型/凭证、不碰用户数据库；延迟、取消和挑战页均确定性注入。
 * 用法：node scripts/e2e-search-contract.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'
import { createSearchTool, runSearch } from '../services/brain/src/tools/search.ts'

const results = []
async function check(name, run) {
  try {
    await run()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.error(`FAIL  ${name} — ${error.message}`)
  }
}
const received = []
let mode = 'markup'
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://test')
  let body = ''
  for await (const chunk of req) body += chunk
  received.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null })
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (mode === 'fail') {
    res.writeHead(503).end('unavailable')
    return
  }
  if (mode === 'slow') return
  if (mode === 'empty') {
    res.end('<html><body><div id="b_results"><div class="b_no">No results found</div></div></body></html>')
    return
  }
  if (mode === 'challenge') {
    res.end('<html><title>验证</title><form id="captcha">请输入验证码以继续搜索</form></html>')
    return
  }
  if (url.pathname === '/tavily') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ results: [{ title: 'Tavily', url: 'https://example.org/news?id=7', content: '新闻摘要' }] }))
    return
  }
  if (url.pathname === '/ddg') {
    res.end('<html><body><div class="result web-result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Fprevious-releases">Node.js releases</a></h2><a class="result__snippet">Release notes</a></div></body></html>')
    return
  }
  if (url.pathname === '/sogou') {
    res.end('<html><div data-id="1" class="vrwrap extra"><h3><a href="/link?url=first">第一篇文章</a></h3><div class="text-layout">第一篇摘要</div></div><div class="extra vrwrap"><h3><a href="/link?url=second">第二篇文章</a></h3><div class="text-layout">第二篇摘要</div></div></html>')
    return
  }
  const target = Buffer.from('https://nodejs.org/en/about/previous-releases').toString('base64url')
  res.end(`<html><ol id="b_results">
    <li data-id="a" class='extra b_algo'><h2><a href="https://example.org/report?id=1&amp;lang=zh">版本<em>发布</em></a></h2><div class="b_caption extra"><p>第一条摘要</p></div></li>
    <li class="b_algo extra"><h2><a href="https://example.org/report?id=2&amp;lang=zh">另一篇发布</a></h2><p class="extra b_lineclamp3">第二条摘要</p></li>
    <li class="b_algo"><h2><a href="https://example.org/report?id=1&amp;lang=zh#part">同一篇换锚点</a></h2></li>
    <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${target}&amp;ntb=1">Node.js 官方</a></h2></li>
    <li class="b_algo"><h2><a href="javascript:alert(1)">危险协议</a></h2></li>
  </ol></html>`)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const base = `http://127.0.0.1:${server.address().port}`
const endpoints = { tavily: `${base}/tavily`, bing: `${base}/bing?tenant=42`, so: `${base}/so`, sogou: `${base}/sogou`, duckduckgo: `${base}/ddg` }

try {
  await check('DOM 解析容忍属性顺序、单双引号、多 class，保持中文高亮文本', async () => {
    const out = await runSearch('发布', 5, { engine: 'bing', endpoints })
    assert.equal(out.hits[0]?.title, '版本发布')
    assert.equal(out.hits[0]?.snippet, '第一条摘要')
    assert.equal(out.hits[1]?.snippet, '第二条摘要')
  })
  await check('URL 解码实体、保留有意义查询参数，只对同一文档去重', async () => {
    const out = await runSearch('发布', 5, { engine: 'bing', endpoints })
    assert.equal(out.hits.length, 3)
    assert.equal(out.hits[0]?.url, 'https://example.org/report?id=1&lang=zh')
    assert.equal(out.hits[1]?.url, 'https://example.org/report?id=2&lang=zh')
    assert(out.hits.every((hit) => /^https?:/.test(hit.url)))
  })
  await check('Bing 跳转还原可核对的原文地址', async () => {
    const out = await runSearch('发布', 5, { engine: 'bing', endpoints })
    assert(out.hits.some((hit) => hit.url === 'https://nodejs.org/en/about/previous-releases'))
  })
  await check('自定义端点已有参数时，q 与 tenant 各自正确传递', async () => {
    received.length = 0
    await runSearch('Node.js 中文', 1, { engine: 'bing', endpoints })
    assert.equal(received[0].query.tenant, '42')
    assert.equal(received[0].query.q, 'Node.js 中文')
  })
  await check('搜狗不同跳转参数代表不同文章，不能合成一条', async () => {
    const out = await runSearch('发布', 5, { engine: 'sogou', endpoints })
    assert.equal(out.hits.length, 2)
  })
  await check('DuckDuckGo 使用网页结果而非 Instant Answer 知识摘要', async () => {
    const out = await runSearch('Node.js release', 3, { engine: 'duckduckgo', endpoints })
    assert.equal(out.hits[0]?.url, 'https://nodejs.org/en/about/previous-releases')
    assert.equal(out.hits[0]?.title, 'Node.js releases')
  })
  await check('Tavily 时效条件真的进入结构化请求', async () => {
    received.length = 0
    const out = await runSearch('新闻', 3, { engine: 'tavily', tavilyKey: 'fixture-key', freshness: 'week', endpoints })
    assert.equal(received[0].body.time_range, 'week')
    assert.equal(out.hits[0]?.url, 'https://example.org/news?id=7')
  })
  await check('HTTP 200 验证页是 blocked，而不冒充搜索无匹配', async () => {
    mode = 'challenge'
    const out = await runSearch('新闻', 3, { engine: 'bing', endpoints })
    assert.equal(out.status, 'failed')
    assert.equal(out.errors[0]?.code, 'blocked')
  })
  await check('真实空结果状态是 empty，工具正常返回而非红色故障', async () => {
    mode = 'empty'
    const out = await runSearch('不存在的关键词', 3, { engine: 'bing', endpoints })
    assert.equal(out.status, 'empty')
    const tool = createSearchTool({ engine: 'bing', endpoints })
    const result = await tool.execute('empty', { query: '不存在的关键词' })
    assert.equal(result.details.status, 'empty')
  })
  await check('全部 HTTP 故障时 search 工具抛真实错误，不能显示成功', async () => {
    mode = 'fail'
    const tool = createSearchTool({ endpoints })
    await assert.rejects(tool.execute('failed', { query: '发布' }), /搜索不可用.*HTTP 503/)
  })
  await check('用户取消立即结束，不能再启动后续引擎', async () => {
    mode = 'slow'
    received.length = 0
    const controller = new AbortController()
    const pending = runSearch('取消', 3, { endpoints, signal: controller.signal })
    for (let i = 0; received.length === 0 && i < 100; i += 1) await sleep(5)
    controller.abort(new Error('用户取消测试'))
    await assert.rejects(pending, /用户取消测试/)
    assert.equal(received.length, 1)
  })
  await check('搜索整体时间预算不会累加四个引擎超时', async () => {
    mode = 'slow'
    const startedAt = Date.now()
    const out = await runSearch('慢请求', 3, { endpoints, timeoutMs: 80 })
    assert.equal(out.status, 'failed')
    assert(Date.now() - startedAt < 1000)
  })
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length ? 1 : 0
