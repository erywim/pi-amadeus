/**
 * PIAM-11：模型/状态/工具链分离后的调用方行为契约。
 * 本地模型 SSE + 内存工具；停止/提前关闭迭代器时不得继续请求、执行或留下审批。
 * 不读取用户配置或真实密钥；所有监听、定时器和测试目录均在 finally 清理。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runAgentTurn } from '../services/brain/src/agentTurn.ts'
import { createDb } from '../services/brain/src/db.ts'

const dir = await mkdtemp(join(tmpdir(), 'amadeus-turn-boundary-'))
let closed = false
let stopped
const stoppedRequest = new Promise(resolve => { stopped = resolve })
const server = createServer(async (req, res) => {
  for await (const chunk of req) void chunk
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = delta => res.write(`data: ${JSON.stringify({
    id: 'turn-boundary', object: 'chat.completion.chunk', model: 'boundary-model',
    choices: [{ index: 0, delta, finish_reason: null }]
  })}\n\n`)
  chunk({ role: 'assistant' })
  chunk({ content: '第一段' })
  res.once('close', () => { closed = true; stopped() })
  // 故意不结束：消费者必须负责取消仍在运行的模型请求。
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const target = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', model: 'boundary-model' }
const cfg = { llm: target, db: { path: join(dir, 'brain.db') },
  tools: { bashCwd: dir, confirmTimeoutMs: 1000, searchEndpoints: {} }, skills: { dir: join(dir, 'skills') },
  media: { dir: join(dir, 'media') }, workspace: { root: dir } }
const db = createDb(cfg.db)
try {
  await db.init()
  const userId = (await db.resolveUser('turn-boundary')).id
  await db.setUserConfig(userId, { provider: target, tools: { enabled: false }, compaction: { level: 'off' } })
  await test('提前关闭回合迭代器必须结束模型请求', { timeout: 5000 }, async () => {
    const run = runAgentTurn({ cfg, db, userId, sessionId: 'close-turn', channel: 'desktop', mode: 'text', content: '输出第一段后等待', isolated: true })
    const first = await run.next()
    assert.deepEqual(first.value, { type: 'delta', delta: '第一段' })
    await run.return()
    let timer
    try {
      await Promise.race([stoppedRequest, new Promise(resolve => { timer = setTimeout(resolve, 200) })])
      assert.equal(closed, true, '消费者 return() 后模型 HTTP 仍在运行')
    } finally { clearTimeout(timer) }
  })
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await db.close()
  await rm(dir, { recursive: true, force: true })
}
