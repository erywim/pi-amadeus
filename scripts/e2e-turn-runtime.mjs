/**
 * PIAM-11：独立执行器/工具链/状态机契约。只使用本地假模型、内存工具和临时目录。
 * 顺序回放：运行 → 并发审批 A/B → 仅 A 落定 → B 落定 → 完成；等待审批取消 → 旧回执拒绝。
 * 模型、工具可分别替换，所有监听/计时器/目录在脚本结束前清理。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Type } from 'typebox'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { createModelRuntime } from '../services/brain/src/llm.ts'
import { executeAgent } from '../services/brain/src/turn/agent-executor.ts'
import { createToolChain } from '../services/brain/src/turn/tool-chain.ts'
import { initialTurnState, transitionTurn } from '../services/brain/src/turn/state-machine.ts'
import { toSseEvent } from '../services/brain/src/turn/sse-adapter.ts'
import { resolveBashConfirm } from '../services/brain/src/tools/confirm.ts'
import { resolveDesktopResult } from '../services/brain/src/tools/desktop-bridge.ts'
import { mcpManager } from '../services/brain/src/mcp/manager.ts'
import { startMockLlm } from './mock-llm.mjs'

const dir = await mkdtemp(join(tmpdir(), 'amadeus-turn-runtime-'))
const cfg = { tools: { bashCwd: dir, confirmTimeoutMs: 3000, computerTimeoutMs: 3000, searchEndpoints: {} } }
const chains = []
let runNumber = 0
const chain = (overrides = {}) => {
  const value = createToolChain({ cfg, turnId: `boundary-${++runNumber}`, channel: 'desktop',
    capabilities: { vision: false }, enabled: true, includeMcp: false,
    signal: new AbortController().signal, onEvent: () => {}, ...overrides })
  chains.push(value)
  return value
}
const user = { role: 'user', content: '测试输入', timestamp: 1 }
const fakeModel = { id: 'in-memory-model', name: 'in-memory-model', api: 'openai-completions',
  provider: 'test', baseUrl: '', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const usage = { input: 7, output: 3, totalTokens: 10, cacheRead: 0, cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const assistant = content => ({ role: 'assistant', content, api: 'openai-completions', provider: 'test',
  model: fakeModel.id, usage, stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 2 })

// 不经过 llm.ts/HTTP 的第二种运行时：验证执行器不暗中调用全局模型或注册工具。
function memoryRuntime() {
  let calls = 0
  return { model: fakeModel, get calls() { return calls }, streamFn(model, context) {
    assert.equal(model.id, fakeModel.id)
    assert.equal(context.messages.filter(message => message.role === 'user').length, 1)
    assert.deepEqual(context.tools.map(tool => tool.name), ['echo'])
    calls++
    const content = context.messages.some(message => message.role === 'toolResult')
      ? [{ type: 'text', text: '最终回答' }]
      : [{ type: 'text', text: '处理中' }, { type: 'toolCall', id: 'memory-tool', name: 'echo', arguments: { value: '原始输入' } }]
    const message = assistant(content)
    const stream = createAssistantMessageEventStream()
    stream.push({ type: 'start', partial: message })
    stream.push({ type: 'text_delta', contentIndex: 0, delta: content[0].text, partial: message })
    stream.push({ type: 'done', reason: message.stopReason, message })
    stream.end(message)
    return stream
  } }
}
const mock = await startMockLlm(body => body.messages.some(message => message.role === 'tool')
  ? { text: '工具结束' }
  : { toolCalls: [{ id: 'blocked-bash', name: 'bash', arguments: { command: 'rm -rf /' } }] })
try {
  await test('架构边界：类型擦除后模型/状态/工具模块无反向运行时依赖', async () => {
    const rules = [
      ['runtime/model-dispatcher.ts', /(?:llm|conversation|agentTurn)\.ts|(?:tools|turn|workflow)\//],
      ['llm.ts', /(?:db|conversation|agentTurn)\.ts|(?:tools|turn|workflow)\//],
      ['turn/state-machine.ts', /./],
      ['turn/tool-chain.ts', /(?:llm|conversation|agentTurn|agent-executor|state-machine|model-dispatcher)\.ts|workflow\//],
      ['turn/agent-executor.ts', /(?:llm|db|conversation|agentTurn|tool-chain|state-machine|model-dispatcher|sse-adapter)\.ts/],
      ['tools/net.ts', /llm\.ts/]
    ]
    for (const [file, denied] of rules) {
      const url = new URL(`../services/brain/src/${file}`, import.meta.url)
      const source = await readFile(url, 'utf8')
      const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
      const ast = ts.createSourceFile(fileURLToPath(url), js, ts.ScriptTarget.ES2022)
      for (const node of ast.statements) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          assert.ok(!denied.test(node.moduleSpecifier.text), `${file} 重新依赖 ${node.moduleSpecifier.text}`)
        }
      }
    }
  })
  await test('纯状态机：并发审批、旧回执、失败/取消和终态幂等', () => {
    const initial = initialTurnState()
    let state = transitionTurn(initial, { type: 'start' })
    assert.equal(initial.status, 'preparing')
    state = transitionTurn(state, { type: 'approval_requested', toolCallId: 'A' })
    state = transitionTurn(state, { type: 'approval_requested', toolCallId: 'B' })
    state = transitionTurn(state, { type: 'approval_settled', toolCallId: 'A' })
    assert.deepEqual(state, { status: 'waiting_approval', pendingApprovals: ['B'] })
    assert.equal(transitionTurn(state, { type: 'complete' }), state)
    assert.equal(transitionTurn(state, { type: 'approval_settled', toolCallId: 'A' }), state)
    state = transitionTurn(state, { type: 'approval_settled', toolCallId: 'B' })
    assert.equal(state.status, 'running')
    for (const type of ['complete', 'fail', 'cancel']) {
      const final = transitionTurn(state, { type })
      assert.equal(final.status, { complete: 'completed', fail: 'failed', cancel: 'cancelled' }[type])
      for (const event of [{ type: 'start' }, { type: 'approval_requested', toolCallId: 'late' },
        { type: 'approval_settled', toolCallId: 'B' }, { type: 'complete' }, { type: 'fail' }, { type: 'cancel' }]) {
        assert.equal(transitionTurn(final, event), final, `终态 ${type} 不应被 ${event.type} 复活`)
      }
    }
  })
  await test('内存模型与工具可独立替换：上下文不重复、事件有序、完整结果与 usage 回传', async () => {
    const runtime = memoryRuntime()
    const events = []
    const long = '完整结果'.repeat(2000)
    const tool = { name: 'echo', label: '测试工具', description: '回显输入', parameters: Type.Object({ value: Type.String() }),
      execute: async (id, args, signal, onUpdate) => {
        assert.equal(id, 'memory-tool')
        assert.equal(args.value, '原始输入')
        assert.equal(signal.aborted, false)
        onUpdate({ content: [{ type: 'text', text: '进度' }], details: {} })
        return { content: [{ type: 'text', text: long }], details: { test: true } }
      } }
    const result = await executeAgent({ runtime, systemPrompt: '不加载其它上下文', messages: [user], tools: [tool],
      onEvent: event => events.push(event) })
    assert.equal(result.full, '处理中最终回答')
    assert.equal(result.lastText, '最终回答')
    assert.deepEqual(result.usage, { input: 14, output: 6, total: 20 })
    assert.deepEqual(result.toolNames, ['echo'])
    assert.equal(runtime.calls, 2)
    assert.deepEqual(events.map(event => event.type), ['delta', 'tool_start', 'tool_update', 'tool_end', 'delta'])
    const end = events.find(event => event.type === 'tool_end')
    assert.equal(end.result, long)
    assert.equal(end.details.test, true)
    const wire = toSseEvent(end, 'turn', new Map())
    assert.equal(wire.result, `${long.slice(0, 4000)}…（已截断）`)
    assert.equal(toSseEvent({ type: 'approval_settled', toolCallId: 'A' }, 'turn', new Map()), undefined)
  })
  await test('工具能力矩阵：总关闭、非桌面、computer 门控、额外工具只在开启时注册', () => {
    assert.deepEqual(chain({ enabled: false, promptAdditions: '不可见手册' }).tools, [])
    assert.equal(chain({ enabled: false, promptAdditions: '不可见手册' }).systemPromptAdditions, '')
    assert.ok(chain().tools.some(tool => tool.name === 'bash'))
    assert.ok(!chain({ channel: 'feishu', computerEnabled: true, capabilities: { vision: true } }).tools.some(tool => ['bash', 'computer'].includes(tool.name)))
    assert.ok(!chain({ computerEnabled: true }).tools.some(tool => tool.name === 'computer'))
    assert.ok(!chain({ capabilities: { vision: true } }).tools.some(tool => tool.name === 'computer'))
    assert.ok(chain({ computerEnabled: true, capabilities: { vision: true } }).tools.some(tool => tool.name === 'computer'))
  })
  await test('bash 安全阻断经过真实模型工具循环，不弹审批，结构化 deniedReason 保留', async () => {
    const events = []
    const tools = chain({ onEvent: event => events.push(event) })
    const result = await executeAgent({ runtime: createModelRuntime({ baseUrl: mock.url, apiKey: 'test', model: 'boundary-model', vision: false }),
      systemPrompt: '', messages: [user], tools: tools.tools, beforeToolCall: tools.beforeToolCall,
      onEvent: event => events.push(tools.decorateEvent(event)) })
    assert.equal(result.full, '工具结束')
    assert.equal(events.filter(event => event.type === 'tool_confirm').length, 0)
    assert.equal(events.find(event => event.type === 'tool_end').details.deniedReason, 'blocked')
    assert.equal(events.find(event => event.type === 'tool_end').isError, true)
  })
  await test('等待审批时取消：即时结束、不执行，迟到回执拒绝；过大命令不创建审批', async () => {
    const controller = new AbortController()
    let requested
    const ready = new Promise(resolve => { requested = resolve })
    const tools = chain({ turnId: 'cancel-approval', signal: controller.signal,
      onEvent: event => { if (event.type === 'tool_confirm') requested(event) } })
    const bash = tools.tools.find(tool => tool.name === 'bash')
    const pending = bash.execute('safe-bash', { command: 'printf never-execute' }, controller.signal).catch(error => error)
    const event = await ready
    assert.equal(event.args.command, 'printf never-execute')
    controller.abort()
    assert.equal((await pending).deniedReason, 'aborted')
    assert.equal(resolveBashConfirm('cancel-approval', 'safe-bash', true).ok, false)
    const other = chain()
    await assert.rejects(other.tools.find(tool => tool.name === 'bash').execute('large', { command: 'x'.repeat(16385) }), /超过 16 KiB/)
  })
  await test('MCP computer 工具装配只接收能力和确认回调，关闭时不调用注册器', () => {
    const original = mcpManager.listAgentTools
    const calls = []
    mcpManager.listAgentTools = options => { calls.push(options); return [] }
    try {
      chain({ enabled: false, includeMcp: true })
      assert.equal(calls.length, 0)
      chain({ includeMcp: true, computerEnabled: true, capabilities: { vision: true } })
      assert.equal(calls.at(-1).allowComputerUse, true)
      assert.equal(typeof calls.at(-1).requestConfirm, 'function')
      chain({ includeMcp: true, channel: 'feishu', computerEnabled: true, capabilities: { vision: true } })
      assert.equal(calls.at(-1).allowComputerUse, false)
    } finally { mcpManager.listAgentTools = original }
  })
  await test('bridge 由工具链 dispose 释放：等待的动作拒绝，旧回执不能复活', async () => {
    let request
    const tools = chain({ turnId: 'computer-close', computerEnabled: true, capabilities: { vision: true },
      onEvent: event => { request = event } })
    const pending = tools.tools.find(tool => tool.name === 'computer').execute('screenshot', { action: 'screenshot' }).catch(error => error)
    assert.equal(request.type, 'computer_request')
    tools.dispose()
    assert.match((await pending).message, /结束/)
    assert.equal(resolveDesktopResult({ ...request, approved: false, error: { message: 'late' } }).ok, false)
  })
  await test('已取消执行器不调用模型；空上下文与运行时失败原样交还调用方', async () => {
    let calls = 0
    const runtime = { model: fakeModel, streamFn: () => { calls++; throw new Error('注入的运行时失败') } }
    const options = { runtime, systemPrompt: '', messages: [user], tools: [], onEvent: () => {} }
    const cancelled = await executeAgent({ ...options, signal: AbortSignal.abort() })
    assert.equal(cancelled.aborted, true)
    assert.equal(calls, 0)
    await assert.rejects(executeAgent({ ...options, messages: [] }), /上下文为空/)
    await assert.rejects(executeAgent(options), /注入的运行时失败/)
    assert.equal(calls, 1)
  })
} finally {
  for (const tools of chains) tools.dispose()
  await mock.close()
  await rm(dir, { recursive: true, force: true })
}
