/**
 * 错误检查与循环保护 E2E（隔离 brain + 临时 SQLite + mock LLM）。
 * 复现：模型连续发出同一工具调用且工具返回同一结果；错误检查应在第 8 次后停止。
 * 同时覆盖关闭错误检查、不同参数不误判、配置校验与稳定 SSE 错误分类。
 */
import assert from 'node:assert/strict'
import { startMockLlm } from './mock-llm.mjs'
import { chatTurn, putConfig, resolveUser, startTestBrain } from './test-brain.mjs'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
async function check(name, fn) {
  try {
    await fn()
    report(name, true)
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error))
  }
}

const mock = await startMockLlm((body, entry) => {
  const toolMessages = (body.messages ?? []).filter((message) => message.role === 'tool')
  const callCount = toolMessages.length
  // 仅主对话识别；标题/记忆请求不带工具，直接收尾。
  if (!(body.tools ?? []).some((tool) => tool.function?.name === 'calculate')) return { text: '辅助任务完成。' }
  return {
    text: '',
    toolCalls: [{ id: `guard-call-${entry.at}-${callCount}`, name: 'calculate', arguments: { expression: '1+1' } }]
  }
})
const brain = await startTestBrain()
const userId = await resolveUser(brain.url, `error-guards-${Date.now()}`)

async function config(patch = {}) {
  await putConfig(brain.url, userId, {
    provider: { baseUrl: mock.url, apiKey: 'test-key', model: 'mock-model' },
    tools: { enabled: true },
    responseGuard: { errorChecks: true, maxTurns: 32, maxToolCalls: 96, maxRepeatedToolCalls: 8, maxConsecutiveBlocked: 3 },
    compaction: { level: 'off' },
    workflow: { level: 'off' },
    ...patch
  })
}

try {
  await check('连续相同工具调用达到 8 次后停止并返回稳定错误 code', async () => {
    await config()
    mock.reset()
    const turn = await chatTurn(brain.url, { userId, sessionId: `guard-${Date.now()}`, content: '执行计算' })
    assert.equal(turn.error?.code, 'repeated_blocked_action', JSON.stringify(turn.error))
    assert.ok(turn.error?.message)
    assert.match(turn.error.message, /连续 8 次/)
    assert.equal(mock.mainRequests().length, 8, `模型请求数=${mock.mainRequests().length}`)
  })

  await check('关闭重复检查后由 maxToolCalls 兜底，仍不会无限请求', async () => {
    await config({ responseGuard: { errorChecks: false, maxTurns: 32, maxToolCalls: 5, maxRepeatedToolCalls: 8, maxConsecutiveBlocked: 3 } })
    mock.reset()
    const turn = await chatTurn(brain.url, { userId, sessionId: `guard-off-${Date.now()}`, content: '执行计算' })
    assert.equal(turn.error?.code, 'max_tool_calls', JSON.stringify(turn.error))
    assert.equal(mock.mainRequests().length, 5, `模型请求数=${mock.mainRequests().length}`)
  })

  await check('不同参数会重置连续重复计数，不误判为重复循环', async () => {
    let calls = 0
    mock.setHandler((body) => {
      if (!(body.tools ?? []).some((tool) => tool.function?.name === 'calculate')) return { text: '辅助任务完成。' }
      calls += 1
      if (calls <= 8) {
        return { text: '', toolCalls: [{ id: `vary-${calls}`, name: 'calculate', arguments: { expression: `${calls}+1` } }] }
      }
      return { text: '参数变化后完成。' }
    })
    await config()
    mock.reset()
    const turn = await chatTurn(brain.url, { userId, sessionId: `guard-vary-${Date.now()}`, content: '执行变化计算' })
    assert.equal(turn.error, undefined, JSON.stringify(turn.error))
    assert.match(turn.full, /参数变化后完成/)
  })

  await check('错误检查配置拒绝非法阈值且不写入', async () => {
    const before = await (await fetch(`${brain.url}/api/config/${userId}`)).json()
    const response = await fetch(`${brain.url}/api/config/${userId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { responseGuard: { maxToolCalls: 0 } } })
    })
    assert.equal(response.status, 400)
    const after = await (await fetch(`${brain.url}/api/config/${userId}`)).json()
    assert.deepEqual(after.config.responseGuard, before.config.responseGuard)
  })
} finally {
  await mock.close()
  await brain.stop()
}

const failed = results.filter((result) => !result.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} error guard checks passed ===`)
if (failed.length > 0) process.exitCode = 1
