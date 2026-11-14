/**
 * 上下文压缩 E2E（假 LLM + 临时库 + 独立 brain 子进程，无外部依赖）：
 *
 *  A 关闭档位：历史按最近 40 条截断（旧行为不变）
 *  B 均衡档位触发：历史超过阈值 → 发摘要请求 → 上下文变成"摘要 + 最近 8 条原文"，
 *    最早的消息不再进请求；SSE 有 compact 事件
 *  C 边界持久化：第二回合不再重复摘要，摘要仍在上下文里
 *  D 摘要失败：整回合照常完成，保留完整历史（不写边界、不丢消息）
 *  E 回合内微压缩：较早的工具结果被替换成占位符，最近 3 条与用户消息不动
 *
 * 断言口径是"真正发给模型的请求体"（mock LLM 记录），不是内部函数返回值，
 * 所以它验证的是用户能感知的行为：模型到底看到了什么。
 *
 * 用法：node scripts/e2e-context.mjs
 */
import assert from 'node:assert/strict'
import { startMockLlm, messageText, nonSystemMessages } from './mock-llm.mjs'
import { chatTurn, putConfig, resolveUser, seedMessages, startTestBrain } from './test-brain.mjs'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    report(name, true, detail ?? '')
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error))
  }
}

/** 一段 5000 字的中文，用来把历史撑过压缩阈值（CJK ≈ 1 token/字） */
function filler(marker, chars = 5000) {
  return `${marker}：` + '这是一段用来占据上下文的历史内容。'.repeat(Math.ceil(chars / 18)).slice(0, chars)
}

const SUMMARY_TEXT = '## 用户的核心诉求\n用户在做压缩相关的测试。\n\n## 关键信息与设定\n无'

/** 默认 handler：摘要按剧本返回，记忆/标题/主对话各自有固定回复 */
function defaultHandler(body) {
  const system = (body.messages ?? []).find((m) => m.role === 'system' || m.role === 'developer')?.content ?? ''
  const text = typeof system === 'string' ? system : ''
  if (text.includes('summarizing conversations')) {
    return { text: `<analysis>梳理</analysis>\n<summary>${SUMMARY_TEXT}</summary>` }
  }
  if (text.includes('长期记忆整理器')) return { text: 'NONE' }
  if (text.includes('标题生成器')) return { text: '压缩测试' }
  return { text: '收到。' }
}

const mock = await startMockLlm(defaultHandler)

const brain = await startTestBrain()
const userId = await resolveUser(brain.url, `context-e2e-${Date.now()}`)
await putConfig(brain.url, userId, {
  provider: { baseUrl: mock.url, apiKey: 'test-key', model: 'mock-model' },
  compaction: { level: 'off' },
  workflow: { level: 'off' }
})

try {
  // ---------- A 关闭档位：最近 40 条 ----------
  await check('A 关闭压缩：只带最近 40 条历史', async () => {
    const sessionId = `ctx-off-${Date.now()}`
    const seeded = []
    for (let i = 0; i < 50; i += 1) {
      seeded.push({ id: `${sessionId}-m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条` })
    }
    await seedMessages(brain.dbPath, sessionId, userId, seeded)
    mock.reset()
    const turn = await chatTurn(brain.url, { userId, sessionId, content: '现在呢？' })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    const main = mock.mainRequests().at(-1)
    assert.ok(main, '没有主对话请求')
    const count = nonSystemMessages(main.body).length
    assert.equal(count, 41, `期望 40 条历史 + 1 条当前消息，实际 ${count}`)
    assert.equal(mock.byKind('summary').length, 0, '关闭档位不应发起摘要请求')
    assert.equal(turn.events.some((e) => e.type === 'compact'), false, '关闭档位不应发 compact 事件')
  })

  // ---------- B 均衡档位触发 ----------
  const bigSession = `ctx-big-${Date.now()}`
  {
    const seeded = []
    for (let i = 0; i < 20; i += 1) {
      seeded.push({
        id: `${bigSession}-m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: filler(`历史第 ${i} 条`)
      })
    }
    await seedMessages(brain.dbPath, bigSession, userId, seeded)
  }
  await putConfig(brain.url, userId, { compaction: { level: 'balanced' } })

  await check('B 均衡档位：超阈值触发摘要并折叠旧历史', async () => {
    mock.reset()
    const turn = await chatTurn(brain.url, { userId, sessionId: bigSession, content: '继续聊' })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)

    const summaryCalls = mock.byKind('summary')
    assert.ok(summaryCalls.length >= 1, `期望发起摘要请求，实际 ${summaryCalls.length}`)

    const main = mock.mainRequests().at(-1)
    assert.ok(main, '没有主对话请求')
    const messages = nonSystemMessages(main.body)
    // 摘要 1 条 + 保留 8 条原文 + 当前消息 1 条
    assert.equal(messages.length, 10, `期望 摘要+8 条保留+当前 = 10 条，实际 ${messages.length}`)
    assert.ok(messageText(messages[0]).includes('用户在做压缩相关的测试'), '上下文第一条应是摘要内容')
    const serialized = JSON.stringify(main.body)
    assert.ok(!serialized.includes('历史第 0 条'), '被折叠的最早消息不应再出现在上下文里')
    assert.ok(serialized.includes('历史第 19 条'), '最近的原文应保留在上下文里')

    const compact = turn.events.find((e) => e.type === 'compact')
    assert.ok(compact, '缺少 compact SSE 事件')
    assert.equal(compact.summarizedMessages, 12, `应折叠 12 条，实际 ${compact.summarizedMessages}`)
    assert.ok(compact.tokensBefore > compact.tokensAfter, '压缩后 token 应下降')
    return `折叠 ${compact.summarizedMessages} 条，${compact.tokensBefore} → ${compact.tokensAfter} tokens`
  })

  await check('C 边界持久化：下一回合不重复摘要，摘要仍在', async () => {
    mock.reset()
    const turn = await chatTurn(brain.url, { userId, sessionId: bigSession, content: '还记得吗？' })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    assert.equal(mock.byKind('summary').length, 0, '第二回合不应再次摘要')
    const main = mock.mainRequests().at(-1)
    const messages = nonSystemMessages(main.body)
    assert.ok(messageText(messages[0]).includes('用户在做压缩相关的测试'), '摘要应继续留在上下文里')
    assert.ok(!JSON.stringify(main.body).includes('历史第 0 条'), '旧消息仍不应回来')
  })

  // ---------- D 摘要失败：不破坏回合 ----------
  await check('D 摘要失败：回合照常完成且保留完整历史', async () => {
    const sessionId = `ctx-fail-${Date.now()}`
    const seeded = []
    for (let i = 0; i < 20; i += 1) {
      seeded.push({
        id: `${sessionId}-m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: filler(`失败历史第 ${i} 条`)
      })
    }
    await seedMessages(brain.dbPath, sessionId, userId, seeded)

    mock.setHandler((body) => {
      const system = (body.messages ?? []).find((m) => m.role === 'system' || m.role === 'developer')?.content ?? ''
      if (String(system).includes('summarizing conversations')) return { status: 500, error: 'summary down' }
      if (String(system).includes('长期记忆整理器')) return { text: 'NONE' }
      return { text: '照样回复。' }
    })
    mock.reset()
    const turn = await chatTurn(brain.url, { userId, sessionId, content: '压缩失败也要能聊' })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    assert.equal(turn.full, '照样回复。')
    const main = mock.mainRequests().at(-1)
    const messages = nonSystemMessages(main.body)
    assert.equal(messages.length, 21, `摘要失败应保留 20 条历史 + 当前 = 21，实际 ${messages.length}`)
    assert.equal(turn.events.some((e) => e.type === 'compact'), false, '摘要失败不应发 compact 事件')
    // 恢复默认 handler，避免影响后续
    mock.setHandler(defaultHandler)
  })

  // ---------- E 回合内微压缩（模块行为） ----------
  await check('E 回合内微压缩：旧工具结果换占位符，最近 3 条与用户消息不动', async () => {
    const { microCompactMessages } = await import('../services/brain/src/context/micro.ts')
    const messages = []
    for (let i = 0; i < 10; i += 1) {
      messages.push({ role: 'user', content: `问题 ${i}`, timestamp: i })
      messages.push({
        role: 'toolResult',
        toolCallId: `call-${i}`,
        toolName: 'search',
        content: [{ type: 'text', text: `工具结果 ${i} `.repeat(200) }],
        isError: false,
        timestamp: i
      })
    }
    const compacted = microCompactMessages(messages, { keepRecentToolResults: 3 })
    const toolResults = compacted.filter((m) => m.role === 'toolResult')
    const stubbed = toolResults.filter((m) => m.content[0].text.startsWith('[较早的工具结果已压缩'))
    const kept = toolResults.filter((m) => m.content[0].text.startsWith('工具结果'))
    assert.equal(stubbed.length, 7, `10 条工具结果应压缩 7 条，实际 ${stubbed.length}`)
    assert.equal(kept.length, 3, `应保留最近 3 条原文，实际 ${kept.length}`)
    assert.ok(stubbed[0].content[0].text.includes('search'), '占位符应带工具名')
    const userMessages = compacted.filter((m) => m.role === 'user')
    assert.equal(userMessages.length, 10)
    assert.ok(
      userMessages.every((m, i) => m.content === `问题 ${i}`),
      '用户消息必须原样保留'
    )
    assert.ok(messages[3].content[0].text.startsWith('工具结果'), '不得修改入参数组')
  })
} finally {
  await brain.stop()
  await mock.close()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
