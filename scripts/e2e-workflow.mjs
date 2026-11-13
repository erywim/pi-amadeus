/**
 * 动态工作流 E2E（假 LLM + 临时库 + 独立 brain 子进程，无外部依赖）：
 *
 *  A 关闭档位：模型完全看不到 workflow 工具，system prompt 也没有编排手册
 *  B 标准档位：工具与手册都注入
 *  C 脚本执行：parallel 并发两个子代理，返回值回到模型，子代理拿不到 bash
 *  D 结构化输出：agent(..., { schema }) 拿回校验过的对象
 *  E 非法脚本：缺 meta 的错误回给模型（可自我修正），不炸回合
 *  F 档位上限：超过 maxAgents 的脚本明确失败并说明上限
 *
 * 断言口径：mock LLM 记录的真实请求体 + 模型收到的工具结果。
 *
 * 用法：node scripts/e2e-workflow.mjs
 */
import assert from 'node:assert/strict'
import { startMockLlm, messageText } from './mock-llm.mjs'
import { chatTurn, putConfig, resolveUser, startTestBrain } from './test-brain.mjs'

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

function toolNamesOf(body) {
  return (body?.tools ?? []).map((tool) => tool.function?.name).filter(Boolean)
}
function systemTextOf(body) {
  const system = (body?.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
  return typeof system === 'string' ? system : JSON.stringify(system)
}
/** 工具结果消息（pi-ai 把 toolResult 转成 OpenAI 的 role:'tool'） */
function toolResultsOf(body) {
  return (body?.messages ?? []).filter((m) => m.role === 'tool')
}

// 每个场景要模型"第一轮就调用 workflow"的脚本与实参，由 runScenario 设置
let pendingScript = ''
let pendingArgs
const subAgentPrompts = []

const mock = await startMockLlm((body) => {
  const system = systemTextOf(body)
  if (system.includes('长期记忆整理器')) return { text: 'NONE' }
  if (system.includes('标题生成器')) return { text: '工作流测试' }
  if (system.includes('summarizing conversations')) return { text: '<summary>摘要</summary>' }

  // 子代理：按 system prompt 区分，回显任务提示；要求 schema 时回 JSON
  if (system.includes('多代理工作流中的一名子代理')) {
    const prompt = messageText((body.messages ?? []).filter((m) => m.role === 'user').at(-1))
    subAgentPrompts.push(prompt)
    if (system.includes('【输出格式】')) return { text: '```json\n{"answer": 42, "ok": true}\n```' }
    return { text: `子代理回复：${prompt}` }
  }

  // 主对话：已经拿到工具结果 → 收尾；否则发起工具调用
  if (toolResultsOf(body).length > 0) return { text: '工作流跑完了。' }
  if (pendingScript) {
    return {
      text: '',
      toolCalls: [
        {
          id: `call-${Date.now()}`,
          name: 'workflow',
          arguments: { script: pendingScript, ...(pendingArgs === undefined ? {} : { args: pendingArgs }) }
        }
      ]
    }
  }
  return { text: '收到。' }
})

const brain = await startTestBrain()
const userId = await resolveUser(brain.url, `workflow-e2e-${Date.now()}`)
await putConfig(brain.url, userId, {
  provider: { baseUrl: mock.url, apiKey: 'test-key', model: 'mock-model' },
  compaction: { level: 'off' },
  workflow: { level: 'off' }
})

/** 跑一个回合，模型会按 pendingScript 调用 workflow */
async function runScenario({ level, script, args }) {
  await putConfig(brain.url, userId, { workflow: { level } })
  // 上一回合的标题/记忆提取是后台请求，等它落地再清空记录，避免串场
  await new Promise((resolve) => setTimeout(resolve, 300))
  pendingScript = script
  pendingArgs = args
  subAgentPrompts.length = 0
  mock.reset()
  const sessionId = `wf-${level}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const turn = await chatTurn(brain.url, { userId, sessionId, content: '用工作流处理一下' })
  return { turn, requests: mock.requests }
}

try {
  await check('A 关闭档位：没有 workflow 工具与手册', async () => {
    const { turn } = await runScenario({ level: 'off', script: '' })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    const main = mock.mainRequests().at(-1)
    assert.ok(main, '没有主对话请求')
    assert.ok(!toolNamesOf(main.body).includes('workflow'), `不应出现 workflow 工具：${toolNamesOf(main.body)}`)
    assert.ok(!systemTextOf(main.body).includes('【动态工作流'), '关闭档位不应注入编排手册')
  })

  await check('B 标准档位：注入 workflow 工具与编排手册', async () => {
    const { turn } = await runScenario({ level: 'standard', script: '' })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    const main = mock.mainRequests().at(-1)
    assert.ok(toolNamesOf(main.body).includes('workflow'), `缺少 workflow 工具：${toolNamesOf(main.body)}`)
    const system = systemTextOf(main.body)
    assert.ok(system.includes('【动态工作流'), '缺少编排手册')
    assert.ok(system.includes('export const meta'), '手册应包含脚本契约')
  })

  await check('C parallel 并发两个子代理，返回值回到模型', async () => {
    const script = `
export const meta = { name: '并行调研', description: '两个角度并行取结果', phases: [{ title: '调研' }] }
phase('调研')
const results = await parallel([
  () => agent('子任务A：' + args.topic, { label: 'A' }),
  () => agent('子任务B：' + args.topic, { label: 'B' })
])
return { results }
`
    const { turn } = await runScenario({ level: 'standard', script, args: { topic: '量子计算' } })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    assert.equal(subAgentPrompts.length, 2, `应调用 2 个子代理，实际 ${subAgentPrompts.length}`)
    assert.deepEqual(subAgentPrompts.sort(), ['子任务A：量子计算', '子任务B：量子计算'])

    // 子代理的请求里不应出现 bash（工作流没有确认通道）
    const subRequest = mock.requests.find((entry) => systemTextOf(entry.body).includes('多代理工作流中的一名子代理'))
    assert.ok(subRequest, '没有子代理请求')
    assert.ok(!toolNamesOf(subRequest.body).includes('bash'), `子代理不应有 bash：${toolNamesOf(subRequest.body)}`)

    // 工具结果回到模型
    const followUp = mock.mainRequests().at(-1)
    const toolResult = toolResultsOf(followUp.body).at(-1)
    assert.ok(toolResult, '模型没有收到工具结果')
    const text = messageText(toolResult)
    assert.ok(text.includes('并行调研'), '结果里应有 meta.name')
    assert.ok(text.includes('子代理回复：子任务A'), '结果里应有 A 的输出')
    assert.ok(text.includes('子代理回复：子任务B'), '结果里应有 B 的输出')
    assert.ok(text.includes('2 个子代理'), '结果里应有运行统计')
    assert.equal(turn.full, '工作流跑完了。')
  })

  await check('D schema：结构化输出被校验并作为对象返回', async () => {
    const script = `
export const meta = { name: '结构化', description: '拿一个结构化结果' }
const result = await agent('给个对象', {
  schema: { type: 'object', properties: { answer: { type: 'number' }, ok: { type: 'boolean' } }, required: ['answer', 'ok'] }
})
return result
`
    const { turn } = await runScenario({ level: 'standard', script })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    const followUp = mock.mainRequests().at(-1)
    const toolResult = toolResultsOf(followUp.body).at(-1)
    assert.ok(toolResult, '模型没有收到工具结果')
    const text = messageText(toolResult)
    assert.ok(text.includes('"answer": 42'), `返回值里应有结构化对象：${text.slice(0, 300)}`)
    // 子代理的 system prompt 里应带 schema 指令
    const subRequest = mock.requests.find((entry) => systemTextOf(entry.body).includes('多代理工作流中的一名子代理'))
    assert.ok(systemTextOf(subRequest.body).includes('【输出格式】'), '子代理应收到 schema 指令')
  })

  await check('E 缺少 meta：错误回给模型，回合不炸', async () => {
    const script = `const x = await agent('随便'); return x`
    const { turn } = await runScenario({ level: 'standard', script })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    const followUp = mock.mainRequests().at(-1)
    const toolResult = toolResultsOf(followUp.body).at(-1)
    assert.ok(toolResult, '模型没有收到工具结果')
    assert.ok(messageText(toolResult).includes('meta'), `错误应说明 meta 问题：${messageText(toolResult).slice(0, 200)}`)
  })

  await check('F 档位上限：超过 maxAgents 明确失败', async () => {
    // standard 档上限 12 个子代理；脚本顺序调用 13 个
    const script = `
export const meta = { name: '超限', description: '超过子代理上限' }
const out = []
for (let i = 0; i < 13; i += 1) {
  out.push(await agent('任务' + i))
}
return out
`
    const { turn } = await runScenario({ level: 'standard', script })
    assert.equal(turn.error, undefined, `回合报错：${turn.error}`)
    assert.equal(subAgentPrompts.length, 12, `上限内应只跑 12 个，实际 ${subAgentPrompts.length}`)
    const followUp = mock.mainRequests().at(-1)
    const toolResult = toolResultsOf(followUp.body).at(-1)
    const text = messageText(toolResult)
    assert.ok(text.includes('最多执行 12 个子代理'), `应说明上限：${text.slice(0, 300)}`)
    assert.ok(text.includes('失败'), '结果状态应为失败')
  })
} finally {
  await brain.stop()
  await mock.close()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
