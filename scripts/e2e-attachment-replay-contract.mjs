/**
 * 附件重放回归（来源：本轮已核实的编辑/重新生成丢附件报告）。
 * 序列：原用户消息带图片/文本/转写 → regenerate/edit → 捕获真实 OpenAI 请求；
 * 编辑成功后删新副本不伤旧文件；注入模型/文件失败时旧分支与附件不变。
 * node scripts/e2e-attachment-replay-contract.mjs
 * 临时 SQLite/media + 环回 OpenAI SSE mock；只 stub 记忆后台任务与 STT，不读 .env/真实数据。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { URL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'amadeus-attachment-replay-'))
const mediaDir = join(dir, 'media')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3QCwAAAABJRU5ErkJggg=='
const TEXT = '保存时的文本抽取，不能丢失或重复'
const TRANSCRIPT = '保存时的语音转写，不应再次调用STT'
const requests = []
let status = 200
let sttCalls = 0
let held = null
const pendingResponses = new Set()
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function within(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等待超时：${label}`)), 3000)
    })])
  } finally { clearTimeout(timer) }
}
const key = Symbol.for('amadeus.attachment-replay-contract')
globalThis[key] = { transcribe: async () => { sttCalls += 1; return '错误的重新转写' } }
const memoryUrl = new URL('../services/brain/src/memory/index.ts', import.meta.url).href
const sttUrl = new URL('../services/brain/src/stt.ts', import.meta.url).href
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === memoryUrl) return {
      format: 'module', shortCircuit: true,
      source: 'export const recallMemories = async () => []; export const summarizeAffinity = async () => ""; export const memorySystemPrompt = () => ""; export const onTurnFinished = async () => {};'
    }
    if (url === sttUrl) return {
      format: 'module', shortCircuit: true,
      source: 'export const transcribe = (...args) => globalThis[Symbol.for("amadeus.attachment-replay-contract")].transcribe(...args);'
    }
    return nextLoad(url, context)
  }
})
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push(body)
  if (held) {
    const current = held
    pendingResponses.add(res)
    res.once('close', () => pendingResponses.delete(res))
    current.started.resolve()
    await current.release.promise
    if (res.destroyed) return
  }
  if (status !== 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '注入的模型失败', type: 'invalid_request_error' } }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: 'attachment-contract', object: 'chat.completion.chunk', model: body.model,
    choices: [{ index: 0, delta, finish_reason }]
  })}\n\n`)
  chunk({ role: 'assistant' })
  chunk({ content: '附件重放回复' })
  chunk({}, 'stop')
  res.end('data: [DONE]\n\n')
})
let db
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const [{ createDb }, { chatRoutes }, { saveAttachment }, { clearProviderFailures }] = await Promise.all([
    import('../services/brain/src/db.ts'), import('../services/brain/src/routes/chat.ts'),
    import('../services/brain/src/media.ts'), import('../services/brain/src/providers/failover.ts')
  ])
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const cfg = {
    port: 0, db: { path: join(dir, 'test.db') }, llm: { baseUrl, apiKey: 'mock-key', model: 'contract-text' },
    whisper: { apiKey: 'mock-key', baseUrl, model: 'whisper', proxy: '' },
    tools: { tavilyKey: '', confirmTimeoutMs: 1000, bashCwd: dir, searchEndpoints: {} },
    workspace: { root: dir }, skills: { dir: join(dir, 'skills') }, media: { dir: mediaDir }
  }
  db = createDb(cfg.db)
  await db.init()
  const userId = (await db.resolveUser('attachment-replay')).id
  await db.setUserConfig(userId, { tools: { enabled: false }, outputLanguage: 'zh', systemPrompt: '' })
  const provider = { baseUrl, apiKey: 'mock-key', proxy: '', dailyTokenQuota: 0, thinkingLevel: 'off', contextWindow: 0, maxTokens: 0, enabled: true, priority: 0 }
  const chat = await db.createProvider({ ...provider, name: 'chat', model: 'contract-text', tags: 'chat' })
  await db.createProvider({ ...provider, name: 'vision', model: 'contract-vision', tags: 'vision' })
  await db.setActiveProvider(chat.id)
  const app = chatRoutes(cfg, db)
  const files = () => existsSync(mediaDir) ? readdirSync(mediaDir).sort() : []
  async function fixture({ image = true, assistant = true } = {}) {
    status = 200
    clearProviderFailures()
    const sessionId = randomUUID()
    await db.touchSession({ id: sessionId, userId, channel: 'desktop' })
    await db.setSessionTitle(sessionId, '已命名，避免后台生成标题')
    const parentUser = randomUUID()
    const parent = randomUUID()
    await db.appendMessage({ id: parentUser, sessionId, role: 'user', content: '之前的问题', mode: 'text', parentId: null })
    await db.appendMessage({ id: parent, sessionId, role: 'assistant', content: '之前的回答', mode: 'text', parentId: parentUser })
    const originalUserId = randomUUID()
    const attachments = [
      ...(image ? [saveAttachment({ name: 'image.png', mimeType: 'image/png', data: PNG }, mediaDir)] : []),
      saveAttachment({ name: 'text.txt', mimeType: 'text/plain', data: Buffer.from('原始文件字节和抽取文本不同').toString('base64') }, mediaDir, { extractedText: TEXT }),
      saveAttachment({ name: 'voice.wav', mimeType: 'audio/wav', data: Buffer.from('原始音频字节').toString('base64') }, mediaDir, { extractedText: TRANSCRIPT })
    ]
    await db.appendMessage({ id: originalUserId, sessionId, role: 'user', content: '原问题', mode: 'text', parentId: parent })
    await db.addMessageMedia(originalUserId, attachments)
    const oldAssistantId = randomUUID()
    if (assistant) await db.appendMessage({ id: oldAssistantId, sessionId, role: 'assistant', content: '旧回答', mode: 'text', parentId: originalUserId })
    return { sessionId, originalUserId, oldAssistantId, attachments, parent }
  }
  async function post(path, fixture, extra = {}, signal) {
    const start = requests.length
    const res = await app.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ userId, sessionId: fixture.sessionId, ...extra })
    })
    const text = await res.text()
    const events = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
    return { status: res.status, text, events, done: events.find((event) => event.type === 'done'), request: requests.slice(start).at(-1) }
  }
  function assertCurrentInput(body, expected, image = true) {
    assert.ok(body, '真实模型请求必须到达 mock')
    assert.equal(body.model, image ? 'contract-vision' : 'contract-text')
    const current = body.messages.at(-1)
    assert.equal(current.role, 'user')
    const blocks = Array.isArray(current.content) ? current.content : [{ type: 'text', text: current.content }]
    const text = blocks.filter((item) => item.type === 'text').map((item) => item.text).join('')
    assert.equal(text.split(expected).length - 1, 1, '本次用户正文只出现一次')
    assert.equal(text.split(TEXT).length - 1, 1, '文本抽取只注入一次')
    assert.equal(text.split(TRANSCRIPT).length - 1, 1, '语音转写只注入一次')
    const images = blocks.filter((item) => item.type === 'image_url')
    assert.equal(images.length, image ? 1 : 0)
    if (image) assert.equal(images[0].image_url.url, `data:image/png;base64,${PNG}`)
    assert.equal(sttCalls, 0, '重放不能重新 STT')
  }

  await test('regenerate：当前附件恢复视觉路由与原始图片，文本/转写不重复，不复制用户消息', async () => {
    const f = await fixture()
    const before = await db.getMessage(f.originalUserId)
    const output = await post('/chat/regenerate', f)
    assert.ok(output.done, output.text)
    assertCurrentInput(output.request, '原问题')
    assert.equal((await db.listAllMessages(f.sessionId)).filter((item) => item.role === 'user').length, 2)
    assert.deepEqual((await db.getMessage(f.originalUserId)).attachments, before.attachments)
    assert.ok(await db.getMessage(f.oldAssistantId))
    assert.equal((await db.getMessage(output.done.messageId)).parentId, f.originalUserId)
  })
  await test('regenerate：分支末尾只有用户消息时也重放附件', async () => {
    const f = await fixture({ assistant: false })
    const output = await post('/chat/regenerate', f)
    assert.ok(output.done, output.text)
    assertCurrentInput(output.request, '原问题')
  })
  await test('regenerate：文本和语音无图片时沿用 chat 路由且只注入一次', async () => {
    const f = await fixture({ image: false })
    const output = await post('/chat/regenerate', f)
    assert.ok(output.done, output.text)
    assertCurrentInput(output.request, '原问题', false)
  })
  await test('edit：新分支复制独立 ID/文件和原提取结果，删除副本不伤原件', async () => {
    const f = await fixture()
    const original = await db.getMessage(f.originalUserId)
    const output = await post('/chat/edit', f, { messageId: f.originalUserId, content: '编辑后的问题' })
    assert.ok(output.done, output.text)
    assertCurrentInput(output.request, '编辑后的问题')
    const edited = await db.getMessage(output.done.userMessageId)
    assert.equal(edited.parentId, f.parent)
    assert.equal(edited.attachments.length, original.attachments.length)
    for (const [index, item] of edited.attachments.entries()) {
      const source = original.attachments[index]
      assert.notEqual(item.id, source.id)
      assert.notEqual(item.path, source.path)
      assert.equal(item.extractedText, source.extractedText)
      assert.deepEqual(readFileSync(item.path), readFileSync(source.path))
      rmSync(item.path)
      assert.ok(existsSync(source.path))
    }
    await db.deleteMessage(edited.id)
    assert.deepEqual((await db.getMessage(f.originalUserId)).attachments, original.attachments)
    assert.ok(await db.getMessage(f.oldAssistantId))
  })
  for (const path of ['/chat/regenerate', '/chat/edit']) {
    await test(`${path} 模型失败：旧路径/原附件不变，未提交的新副本清理`, async () => {
      const f = await fixture()
      const beforeFiles = files()
      const before = await db.listAllMessages(f.sessionId)
      const leaf = await db.getActiveLeafId(f.sessionId)
      status = 400
      const output = await post(path, f, { messageId: f.originalUserId, content: '失败的编辑' })
      assert.equal(output.done, undefined)
      assert.ok(output.events.some((item) => item.type === 'error'), output.text)
      assert.equal(await db.getActiveLeafId(f.sessionId), leaf)
      assert.deepEqual(await db.listAllMessages(f.sessionId), before)
      assert.deepEqual(files(), beforeFiles)
    })
  }
  await test('edit：后一个附件丢失时清理已复制的前件，不改旧分支', async () => {
    const f = await fixture()
    rmSync(f.attachments.at(-1).path)
    const before = files()
    const leaf = await db.getActiveLeafId(f.sessionId)
    const output = await post('/chat/edit', f, { messageId: f.originalUserId, content: '缺文件的编辑' })
    assert.equal(output.done, undefined)
    assert.equal(await db.getActiveLeafId(f.sessionId), leaf)
    assert.deepEqual(files(), before)
  })
  await test('edit 取消：模型被卡住期间不切分支，abort 清理副本', async () => {
    const f = await fixture()
    const before = files()
    const leaf = await db.getActiveLeafId(f.sessionId)
    const oldMessages = await db.listAllMessages(f.sessionId)
    const controller = new AbortController()
    held = { started: deferred(), release: deferred() }
    const request = post('/chat/edit', f, { messageId: f.originalUserId, content: '取消的编辑' }, controller.signal)
    try {
      await within(held.started.promise, '模型已收到编辑输入')
      assert.equal(await db.getActiveLeafId(f.sessionId), leaf)
      controller.abort()
      const output = await within(request, '取消后的 SSE 结束')
      assert.equal(output.done, undefined)
      assert.deepEqual(await db.listAllMessages(f.sessionId), oldMessages)
      assert.equal(await db.getActiveLeafId(f.sessionId), leaf)
      assert.deepEqual(files(), before)
    } finally {
      controller.abort()
      held.release.resolve()
      held = null
      for (const response of pendingResponses) response.destroy()
      await within(request, '取消用例清理')
    }
  })
  await test('普通后续回合：历史图片仍仅占位，不重复发送图片', async () => {
    const f = await fixture()
    const output = await post('/chat', f, { content: '后续问题' })
    assert.ok(output.done, output.text)
    assert.equal(output.request.model, 'contract-text')
    assert.equal(JSON.stringify(output.request.messages).includes('data:image/'), false)
  })
} finally {
  const closed = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections()
  await closed
  if (db) await db.close()
  hooks.deregister()
  delete globalThis[key]
  rmSync(dir, { recursive: true, force: true })
}
await test('清理：临时 SQLite/media 已删除，mock 监听已关闭，无 STT 调用', () => {
  assert.equal(existsSync(dir), false)
  assert.equal(server.listening, false)
  assert.equal(sttCalls, 0)
  assert.equal(globalThis[key], undefined)
})
