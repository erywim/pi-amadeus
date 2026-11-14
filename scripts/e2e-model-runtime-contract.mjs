/**
 * 模型运行契约回归（来源：模型参数窄范围修复）：
 * 本地 OpenAI SSE mock 捕获真实 HTTP → 对比参数/错误/截断 → 隔离 SQLite 验证配置与 Agent。
 * 无需桌面端、真实密钥或外网；不读取 .env，不写用户数据，结束关闭数据库与监听。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { getLlm, streamText, completeText, createAgentStreamFn } from '../services/brain/src/llm.ts'
import { createDb } from '../services/brain/src/db.ts'
import { configRoutes } from '../services/brain/src/routes/config.ts'
import { providerRoutes } from '../services/brain/src/routes/providers.ts'
import { runAgentTurn } from '../services/brain/src/agentTurn.ts'
import { generateTitle } from '../services/brain/src/title.ts'
import { extractMemories } from '../services/brain/src/memory/extract.ts'
import { generateProactiveGreeting } from '../services/brain/src/proactive/index.ts'
import { isProviderCoolingDown, markProviderFailure, clearProviderFailures } from '../services/brain/src/providers/failover.ts'

const requests = []
let response = {}
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
  if (response.status) {
    res.writeHead(response.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: response.error, type: 'invalid_request_error' } }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
    id: 'runtime-contract', object: 'chat.completion.chunk', model: 'runtime-contract',
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {})
  })}\n\n`)
  chunk({ role: 'assistant', ...(response.thinking ? { reasoning_content: response.thinking } : {}) })
  if (response.text !== '') chunk({ content: response.text ?? 'OK' })
  if (response.streamError) {
    res.end(`data: ${JSON.stringify({ error: { message: response.streamError } })}\n\n`)
    return
  }
  chunk({}, response.finish ?? 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const dir = await mkdtemp(join(tmpdir(), 'amadeus-runtime-contract-'))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const target = { baseUrl, model: 'runtime-contract', apiKey: 'explicit-mock-key', vision: false }
const context = { messages: [{ role: 'user', content: '只回复 OK', timestamp: 1 }] }
// 手工构造配置，避免 loadConfig 的 .env 副作用；所有可写目录均在本次临时目录内。
const cfg = {
  port: 0, db: { path: join(dir, 'test.db') }, llm: target,
  tools: { tavilyKey: '', confirmTimeoutMs: 1000, bashCwd: dir, searchEndpoints: {} },
  workspace: { root: dir }, skills: { dir: join(dir, 'skills') }, media: { dir: join(dir, 'media') }
}
const db = createDb(cfg.db)
const app = new Hono().route('/api', configRoutes(cfg, db)).route('/api', providerRoutes(db))
const results = []
async function test(name, run) {
  response = {}
  clearProviderFailures()
  try {
    await run()
    results.push(true)
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push(false)
    console.error(`FAIL ${name} — ${error.message}`)
  }
}
async function api(path, method, body) {
  const res = await app.request(`/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: res.status, body: await res.json() }
}
const providerInput = { name: 'runtime contract', baseUrl, apiKey: target.apiKey, model: target.model }
let userId
let session = 0
async function setConfig(temperature = 0.37, provider = {}) {
  await db.setUserConfig(userId, {
    provider: { ...target, ...provider }, temperature, tools: { enabled: false }, systemPrompt: '', outputLanguage: 'zh'
  })
}
async function turn(overrides = {}, channel = 'desktop') {
  const events = []
  const generator = runAgentTurn({ cfg, db, userId, sessionId: `contract-${++session}`, channel, mode: 'text', content: '只回复 OK', ...overrides })
  for (;;) {
    const step = await generator.next()
    if (step.done) return { result: step.value, events }
    events.push(step.value)
  }
}
function cap(body) { return body.max_completion_tokens ?? body.max_tokens }
function assertReasoningOff(body) {
  for (const key of ['reasoning_effort', 'thinking', 'enable_thinking', 'reasoning']) assert.equal(body[key], undefined, key)
}
try {
  await db.init()
  userId = (await db.resolveUser('model-runtime-contract')).id
  await setConfig()

  await test('auth: empty key rejected before HTTP; explicit key reaches mock', async () => {
    const { models, model } = getLlm(target)
    const before = requests.length
    const stream = models.streamSimple(model, context, { apiKey: '' })
    const events = []
    for await (const event of stream) events.push(event)
    assert.match(events.at(-1).error.errorMessage, /Provider is not configured/)
    assert.equal(requests.length, before)
    assert.equal(await completeText(target, context), 'OK')
    assert.equal(requests.length, before + 1)
    assert.equal(requests.at(-1).auth, `Bearer ${target.apiKey}`)
    await assert.rejects(completeText({ ...target, apiKey: '' }, context), /Provider is not configured/)
  })

  await test('stream errors preserve actual upstream HTTP/stream message (not empty success)', async () => {
    response = { status: 400, error: 'image_url is invalid' }
    await assert.rejects(completeText(target, context), /400.*image_url is invalid/s)
    response = { text: 'partial', streamError: 'mock stream failure' }
    let text = ''
    await assert.rejects(async () => { for await (const delta of streamText(target, context)) text += delta }, /mock stream failure/)
    assert.equal(text, 'partial')
  })

  await test('length is explicit failure, with or without text; usage/thinking still delivered', async () => {
    for (const text of ['', 'partial']) {
      response = { finish: 'length', text, thinking: 'reason' }
      let usage, thinking = ''
      await assert.rejects(async () => {
        for await (const delta of streamText(target, context, undefined, u => { usage = u }, d => { thinking += d })) assert.equal(typeof delta, 'string')
      }, /截断.*输出上限|输出上限.*截断/)
      assert.deepEqual(usage, { input: 7, output: 3, total: 10 })
      assert.equal(thinking, 'reason')
    }
  })

  await test('real request fields: reasoning levels, off override, temperature zero, token/context caps', async () => {
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      await completeText({ ...target, thinkingLevel: level, maxTokens: 173 }, context, { temperature: 0.41 })
      const body = requests.at(-1).body
      assert.equal(body.model, target.model)
      assert.equal(body.stream, true)
      assert.equal(body.temperature, 0.41)
      assert.equal(body.reasoning_effort, level)
      assert.equal(cap(body), 173)
    }
    await completeText({ ...target, thinkingLevel: 'high' }, context, { thinkingLevel: 'off', temperature: 0 })
    assertReasoningOff(requests.at(-1).body)
    assert.equal(requests.at(-1).body.temperature, 0)
    await completeText({ ...target, contextWindow: 4200, maxTokens: 8192 }, context)
    assert.ok(cap(requests.at(-1).body) > 0 && cap(requests.at(-1).body) <= 104)
    const fn = createAgentStreamFn({ ...target, thinkingLevel: 'high' }, { thinkingLevel: 'off', temperature: 0 })
    for await (const event of fn(getLlm(target).model, context, { reasoning: 'high' })) assert.notEqual(event.type, 'error')
    assertReasoningOff(requests.at(-1).body)
    assert.equal(requests.at(-1).body.temperature, 0)
  })

  await test('oversized input/system/tools/images rejected in both LLM paths before HTTP, unchanged history', async () => {
    const limited = { ...target, contextWindow: 5000 }
    const { model } = getLlm(limited)
    const cases = [
      { messages: [{ role: 'user', content: 'x'.repeat(12_000), timestamp: 1 }] },
      { ...context, systemPrompt: 'system'.repeat(2_000) },
      { ...context, tools: [{ name: 'large_tool', description: 'schema'.repeat(2_000), parameters: { type: 'object' } }] },
      { messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], timestamp: 1 }] }
    ]
    for (const input of cases) {
      const original = globalThis.structuredClone(input)
      const before = requests.length
      await assert.rejects(completeText(limited, input), /上下文过长/)
      await assert.rejects(async () => {
        for await (const event of createAgentStreamFn(limited)(model, input)) assert.notEqual(event.type, 'error')
      }, /上下文过长/)
      assert.equal(requests.length - before, 0, 'oversized input must send zero requests')
      assert.deepEqual(input, original, 'must not trim or mutate history')
    }
    assert.equal(await completeText(limited, context), 'OK')
    assert.ok(cap(requests.at(-1).body) > 0)
    const provider = (await api('/providers', 'POST', { ...providerInput, contextWindow: 5000 })).body.provider
    await api(`/providers/${provider.id}/active`, 'PUT')
    try {
      const before = requests.length
      await assert.rejects(turn({ content: 'x'.repeat(12_000) }), /上下文过长/)
      assert.equal(requests.length - before, 0)
      assert.equal(isProviderCoolingDown(provider.id), false)
    } finally { await db.deleteProvider(provider.id) }
  })

  await test('resolved runtime reports actual provider after cooldown, zero defaults, no secrets', async () => {
    await setConfig(0.37, { model: 'fallback-model', contextWindow: 64_000, maxTokens: 2048, thinkingLevel: 'low' })
    const first = (await api('/providers', 'POST', { ...providerInput, contextWindow: 0, maxTokens: 0 })).body.provider
    const second = (await api('/providers', 'POST', { ...providerInput, name: 'backup', model: 'backup-model', thinkingLevel: 'high', contextWindow: 32_000, maxTokens: 1024 })).body.provider
    await api(`/providers/${first.id}/active`, 'PUT')
    try {
      let runtime = await api(`/config/${userId}/runtime`, 'GET')
      assert.equal(runtime.status, 200)
      assert.deepEqual(runtime.body, { providerId: first.id, providerName: first.name, model: target.model, contextWindow: 128_000, maxTokens: 8192, thinkingLevel: 'off' })
      markProviderFailure(first.id)
      runtime = await api(`/config/${userId}/runtime`, 'GET')
      assert.deepEqual(runtime.body, { providerId: second.id, providerName: second.name, model: second.model, contextWindow: 32_000, maxTokens: 1024, thinkingLevel: 'high' })
      markProviderFailure(second.id)
      runtime = await api(`/config/${userId}/runtime`, 'GET')
      assert.deepEqual(runtime.body, { providerId: null, providerName: null, model: 'fallback-model', contextWindow: 64_000, maxTokens: 2048, thinkingLevel: 'low' })
      assert.equal(JSON.stringify(runtime.body).includes(target.apiKey), false)
      await setConfig(0.37, { contextWindow: 0, maxTokens: 0, thinkingLevel: 'off' })
      runtime = await api(`/config/${userId}/runtime`, 'GET')
      assert.equal(runtime.body.contextWindow, 128_000)
      assert.equal(runtime.body.maxTokens, 8192)
    } finally {
      await db.deleteProvider(first.id)
      await db.deleteProvider(second.id)
      await setConfig()
    }
  })

  await test('Agent temperature: per-turn override > stored user config; desktop/feishu', async () => {
    await setConfig(0.37)
    for (const channel of ['desktop', 'feishu']) {
      await turn({}, channel)
      assert.equal(requests.at(-1).body.temperature, 0.37)
      await turn({ temperature: 0 }, channel)
      assert.equal(requests.at(-1).body.temperature, 0)
    }
  })

  await test('Agent length cannot return success even after nonempty text, and does not cool provider', async () => {
    const created = await api('/providers', 'POST', providerInput)
    const id = created.body.provider.id
    await api(`/providers/${id}/active`, 'PUT')
    try {
      response = { text: 'partial', finish: 'length' }
      await assert.rejects(turn(), /截断/)
      assert.equal(isProviderCoolingDown(id), false)
    } finally { await db.deleteProvider(id) }
  })

  await test('unrelated HTTP 400 with thinking enabled stays real error and does not cool provider', async () => {
    const created = await api('/providers', 'POST', { ...providerInput, thinkingLevel: 'high' })
    const id = created.body.provider.id
    await api(`/providers/${id}/active`, 'PUT')
    try {
      response = { status: 400, error: 'image_url is invalid' }
      await assert.rejects(turn(), error => /image_url is invalid/.test(error.message) && !/不接受.*思考档位/.test(error.message))
      assert.equal(isProviderCoolingDown(id), false)
      const probe = await api(`/providers/${id}/test`, 'POST')
      assert.equal(probe.body.ok, false)
      assert.match(probe.body.error, /image_url is invalid/)
      assert.equal(isProviderCoolingDown(id), false)
      response = { status: 401, error: 'invalid API key' }
      await assert.rejects(turn(), /401.*invalid API key/s)
      assert.equal(isProviderCoolingDown(id), true)
    } finally { await db.deleteProvider(id) }
  })

  await test('upstream thinking rejection includes real reason without auto-rewriting protocol', async () => {
    await setConfig(0.37, { thinkingLevel: 'high' })
    response = { status: 400, error: 'reasoning_effort high is unsupported' }
    const before = requests.length
    await assert.rejects(turn(), /reasoning_effort high is unsupported/)
    assert.equal(requests.length, before + 1)
    assert.equal(requests.at(-1).body.reasoning_effort, 'high')
    await setConfig()
  })

  await test('config + provider POST/PATCH reject invalid runtime values with 400, no writes', async () => {
    const created = await api('/providers', 'POST', providerInput)
    const id = created.body.provider.id
    const invalid = {
      thinkingLevel: ['bogus', '', 1, null],
      contextWindow: [-1, 1.5, '4096', null, Number.MAX_SAFE_INTEGER + 1],
      maxTokens: [-1, 1.5, '16', null, Number.MAX_SAFE_INTEGER + 1]
    }
    try {
      for (const [key, values] of Object.entries(invalid)) {
        for (const value of values) {
          const configBefore = await db.getUserConfig(userId)
          const providerBefore = await db.getProvider(id)
          const config = await api(`/config/${userId}`, 'PUT', { config: { provider: { [key]: value } } })
          assert.equal(config.status, 400, `config ${key}=${JSON.stringify(value)}`)
          for (const [path, method] of [['/providers', 'POST'], [`/providers/${id}`, 'PATCH']]) {
            const result = await api(path, method, { ...providerInput, [key]: value })
            assert.equal(result.status, 400, `${method} ${key}=${JSON.stringify(value)}`)
          }
          assert.deepEqual(await db.getUserConfig(userId), configBefore)
          assert.deepEqual(await db.getProvider(id), providerBefore)
        }
      }
      for (const temperature of [-0.1, 2.1, '0.5', null]) {
        const result = await api(`/config/${userId}`, 'PUT', { config: { temperature } })
        assert.equal(result.status, 400, `temperature=${JSON.stringify(temperature)}`)
      }
      for (const temperature of [0, 2]) {
        assert.equal((await api(`/config/${userId}`, 'PUT', { config: { temperature, provider: { thinkingLevel: 'off', contextWindow: 0, maxTokens: 0 } } })).status, 200)
      }
    } finally { await db.deleteProvider(id); await setConfig() }
  })

  await test('direct runtime rejects invalid parameters before sending HTTP', async () => {
    const before = requests.length
    for (const options of [{ thinkingLevel: 'typo' }, { temperature: NaN }, { temperature: Infinity }, { maxTokens: -1 }, { maxTokens: 1.5 }]) {
      await assert.rejects(completeText(target, context, options))
    }
    assert.equal(requests.length, before)
  })

  await test('editing provider clears cooldown and keeps blank-key edit compatible', async () => {
    const created = await api('/providers', 'POST', { ...providerInput, thinkingLevel: 'high' })
    const id = created.body.provider.id
    try {
      markProviderFailure(id)
      const result = await api(`/providers/${id}`, 'PATCH', { ...providerInput, apiKey: '', maxTokens: 512 })
      assert.equal(result.status, 200)
      assert.equal(result.body.provider.coolingDown, false)
      assert.equal(result.body.provider.thinkingLevel, 'high')
      assert.equal((await db.getProvider(id)).apiKey, target.apiKey)
    } finally { await db.deleteProvider(id) }
  })

  await test('small tasks explicitly do not inherit reasoning (title/memory/proactive/probe)', async () => {
    const inherited = { ...target, thinkingLevel: 'high' }
    response = { text: '测试标题' }
    assert.equal(await generateTitle(inherited, '问候', '你好'), '测试标题')
    assertReasoningOff(requests.at(-1).body)
    assert.equal(cap(requests.at(-1).body), 512)
    response = { text: 'NONE' }
    assert.equal(await extractMemories({ db, target: inherited, userId, sessionId: 'unused', messageId: 'unused', userText: '我喜欢安静的地方', assistantText: '我记下了' }), 0)
    assertReasoningOff(requests.at(-1).body)
    assert.equal(cap(requests.at(-1).body), 240)
    await setConfig(0.37, { thinkingLevel: 'high' })
    response = { text: '最近怎么样？' }
    assert.ok(await generateProactiveGreeting(cfg, db, userId, { force: true }))
    assertReasoningOff(requests.at(-1).body)
    assert.equal(cap(requests.at(-1).body), 220)
    const created = await api('/providers', 'POST', { ...providerInput, thinkingLevel: 'high' })
    const id = created.body.provider.id
    try {
      response = { text: 'OK' }
      assert.equal((await api(`/providers/${id}/test`, 'POST')).body.ok, true)
      assertReasoningOff(requests.at(-1).body)
      assert.equal(cap(requests.at(-1).body), 16)
    } finally { await db.deleteProvider(id); await setConfig() }
  })
} finally {
  clearProviderFailures()
  await db.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length}/${results.length} model runtime contracts passed`)
if (results.some(ok => !ok)) process.exitCode = 1
