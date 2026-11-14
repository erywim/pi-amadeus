/**
 * 联网搜索 HTTP/Agent 集成：随机端口、自起 brain、临时 DB/media/skills/工作区。
 * 引擎与 OpenAI SSE 均是本地协议 fixture；测试不依赖真实模型，不把429或无工具调用算跳过。
 * 默认 node scripts/e2e-search.mjs；真实联网/真实模型须另行验证，不能用此结果冒充。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'amadeus-search-http-'))
let mode = 'ok'
let toolFailed = false
const requests = []
const modelRequests = []
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture')
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (url.pathname === '/v1/chat/completions') {
    const body = JSON.parse(raw)
    modelRequests.push(body)
    const tool = body.messages.findLast((message) => message.role === 'tool')
    const delta = tool
      ? { role: 'assistant', content: toolFailed ? '搜索确实失败，未编造来源。' : '海边的卡邦克鲁研究' }
      : { role: 'assistant', tool_calls: [{ index: 0, id: `search-${modelRequests.length}`, type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: '卡邦克鲁', maxResults: 3 }) } }] }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'search-http-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ id: 'search-http-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\ndata: [DONE]\n\n`)
    return
  }
  const engine = url.pathname.slice(1)
  requests.push({ engine, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null })
  if (mode === 'failed' || (mode === 'fallback' && engine === 'tavily')) {
    res.writeHead(503).end('injected unavailable')
    return
  }
  if (mode === 'fallback' && engine === 'bing') return // 可确定地等到该引擎超时
  if (mode === 'empty') {
    res.setHeader('Content-Type', engine === 'tavily' ? 'application/json' : 'text/html')
    res.end(engine === 'tavily' ? '{"results":[]}' : '<html><body>No results found</body></html>')
    return
  }
  if (engine === 'tavily') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ results: [{ title: '海边的卡邦克鲁研究', url: 'https://example.org/report?id=1', content: '协议fixture，不是产品数据' }] }))
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (engine === 'bing') {
    res.end('<html><li data-id="1" class="extra b_algo"><h2><a href="https://example.org/report?id=1&amp;lang=zh">海边的<em>卡邦克鲁</em>研究</a></h2><div class="b_caption"><p>摘要 &amp; 正文</p></div></li><li class="b_algo"><h2><a href="https://example.org/report?id=2">第二条</a></h2></li></html>')
  } else if (engine === 'so') {
    res.end('<html><li class="res-list"><h3><a href="https://example.org/report?id=1">360 结果</a></h3><p class="res-desc">摘要</p></li></html>')
  } else if (engine === 'sogou') {
    res.end('<html><div class="vrwrap"><h3><a href="https://example.org/report?id=1">搜狗结果</a></h3></div></html>')
  } else {
    res.end('<html><div class="result"><a class="result__a" href="https://example.org/report?id=1">网页结果</a><a class="result__snippet">摘要</a></div></html>')
  }
})
await new Promise((resolve_, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve_) })
const mockUrl = `http://127.0.0.1:${mock.address().port}`
const reservation = createServer()
await new Promise((resolve_, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve_) })
const port = reservation.address().port
await new Promise((resolve_) => reservation.close(resolve_))
const brainUrl = `http://127.0.0.1:${port}`
let log = ''
const brain = spawn(process.execPath, ['src/index.ts'], {
  cwd: join(root, 'services/brain'),
  env: {
    ...process.env, PORT: String(port), BRAIN_HOST: '127.0.0.1', BRAIN_ADMIN_TOKEN: '',
    DB_PATH: join(dir, 'search.db'), MEDIA_DIR: join(dir, 'media'), SKILLS_DIR: join(dir, 'skills'),
    BASH_TOOL_CWD: dir, WORKSPACE_DIR: dir, FEISHU_ENABLED: 'false',
    LLM_API_KEY: 'local-protocol-fixture', LLM_BASE_URL: `${mockUrl}/v1`, AI_MODEL: 'search-fixture',
    TAVILY_API_KEY: 'local-search-fixture', SEARCH_PROXY: '',
    ...Object.fromEntries(['TAVILY', 'BING', 'SO', 'SOGOU', 'DUCKDUCKGO'].map((engine) => [`SEARCH_${engine}_URL`, `${mockUrl}/${engine.toLowerCase()}`])),
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: ''
  }, stdio: ['ignore', 'pipe', 'pipe']
})
const exited = new Promise((resolve_) => brain.once('exit', resolve_))
brain.stdout.on('data', (chunk) => { log = (log + String(chunk)).slice(-10_000) })
brain.stderr.on('data', (chunk) => { log = (log + String(chunk)).slice(-10_000) })
let spawnError
brain.on('error', (error) => { spawnError = error })
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${brainUrl}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  return { status: response.status, body: await response.json() }
}
const results = []
async function check(name, run) {
  try { await run(); results.push(true); console.log(`PASS  ${name}`) }
  catch (error) { results.push(false); console.error(`FAIL  ${name} — ${error.message}`) }
}
try {
  const startedAt = Date.now()
  // 先等本子进程的启动记录，不能拿已有同端口旧实例的health冒充本次就绪。
  while (!log.includes(`大脑服务已启动: 127.0.0.1:${port}`)) {
    if (spawnError || brain.exitCode !== null || brain.signalCode !== null) throw new Error(`隔离 brain 启动失败：${spawnError?.message ?? log}`)
    if (Date.now() - startedAt > 20_000) throw new Error(`隔离 brain 启动超时：${log}`)
    await sleep(25)
  }
  assert.equal((await api('/health')).body.ok, true)
  await check('HTTP：同一解析器返回 DOM 标题/URL/摘要与真实状态', async () => {
    const result = await api('/search/test', { query: '卡邦克鲁', engine: 'bing' })
    assert.equal(result.body.status, 'success')
    assert.equal(result.body.hits[0].title, '海边的卡邦克鲁研究')
    assert.equal(result.body.hits[0].url, 'https://example.org/report?id=1&lang=zh')
    assert.equal(result.body.hits[0].snippet, '摘要 & 正文')
  })
  await check('HTTP：状态探测五引擎与有效网络路径', async () => {
    const result = await api('/search/status')
    assert.equal(result.body.engines.length, 5)
    assert(result.body.engines.every((engine) => engine.ok), JSON.stringify(result.body.engines))
    assert.equal(result.body.network, 'direct')
  })
  await check('HTTP：注入503→超时→成功，降级顺序与原因保留', async () => {
    mode = 'fallback'; requests.length = 0
    const result = await api('/search/test', { query: '降级' })
    assert.equal(result.body.status, 'success')
    assert.equal(result.body.engine, 'so')
    assert.deepEqual(requests.map((item) => item.engine), ['tavily', 'bing', 'so'])
    assert.equal(result.body.errors.length, 2)
  })
  await check('HTTP：空匹配与全故障不能混淆', async () => {
    mode = 'empty'
    assert.equal((await api('/search/test', { query: '空结果' })).body.status, 'empty')
    mode = 'failed'
    const result = await api('/search/test', { query: '故障' })
    assert.equal(result.body.status, 'failed')
    assert.equal(result.body.errors.length, 5)
  })
  await check('HTTP：时效真正传给支持的引擎', async () => {
    mode = 'ok'; requests.length = 0
    await api('/search/test', { query: '新闻', engine: 'tavily', freshness: 'week' })
    assert.equal(requests[0].body.time_range, 'week')
    requests.length = 0
    await api('/search/test', { query: '新闻', engine: 'bing', freshness: 'day' })
    assert.match(requests[0].query.filters, /ez1/)
  })
  await check('HTTP：非法参数拒绝，公网读取本机/file/私网拒绝', async () => {
    for (const body of [{ query: '' }, { query: 'x', engine: 'unknown' }, { query: 'x', freshness: 'forever' }, { query: 'x', maxResults: '5' }]) assert.equal((await api('/search/test', body)).status, 400)
    for (const url of ['http://127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://192.168.1.1/', 'file:///etc/passwd']) assert.equal((await api('/search/fetch', { url })).status, 400)
  })
  const userId = (await api('/users/resolve', { username: 'search-http-fixture' })).body.userId
  // 定义小输出预算、关闭后台标题/记忆请求，fixture验证的是Agent协议接线而非模型智能。
  await api(`/config/${userId}`, { config: { provider: { baseUrl: `${mockUrl}/v1`, model: 'search-fixture', apiKey: 'local-protocol-fixture', maxTokens: 512 } } }, 'PUT')
  async function turn(sessionId) {
    const response = await fetch(`${brainUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, sessionId, content: '用search搜索卡邦克鲁并给出处' }), signal: AbortSignal.timeout(30_000) })
    return (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  }
  await check('Agent：search工具执行→结果回流→正文落库→done，无跳过', async () => {
    mode = 'ok'; toolFailed = false
    const events = await turn('search-http-success')
    assert(events.some((event) => event.type === 'tool_start' && event.toolName === 'search'))
    assert(events.some((event) => event.type === 'tool_end' && event.toolName === 'search' && !event.isError && event.result.includes('example.org')))
    assert(events.some((event) => event.type === 'done'))
    assert(!events.some((event) => event.type === 'error'))
    const messages = (await api('/sessions/search-http-success/messages')).body.messages
    assert.equal(messages.at(-1).content, '海边的卡邦克鲁研究')
  })
  await check('Agent：全部故障产生tool_end.isError，不显示搜索成功', async () => {
    mode = 'failed'; toolFailed = true
    const events = await turn('search-http-failed')
    assert(events.some((event) => event.type === 'tool_end' && event.toolName === 'search' && event.isError && event.result.includes('搜索不可用')))
    assert(events.some((event) => event.type === 'delta' && event.delta.includes('搜索确实失败')))
    assert(events.some((event) => event.type === 'done'))
  })
} finally {
  if (brain.exitCode === null && brain.signalCode === null) {
    brain.kill('SIGTERM')
    let timer
    await Promise.race([exited, new Promise((resolve_) => { timer = setTimeout(resolve_, 5000) })])
    clearTimeout(timer)
    if (brain.exitCode === null && brain.signalCode === null) { brain.kill('SIGKILL'); await exited }
  }
  mock.closeAllConnections()
  await new Promise((resolve_) => mock.close(resolve_))
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length}/${results.length} 通过（协议fixture，无外网/真实模型/跳过）`)
process.exitCode = results.every(Boolean) ? 0 : 1
