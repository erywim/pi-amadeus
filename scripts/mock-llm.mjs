/**
 * 测试用的假 LLM 服务（OpenAI 兼容 /v1/chat/completions，SSE 流式）。
 *
 * 用途：上下文压缩与动态工作流的 E2E 需要**确定性地**观察"发给模型的上下文"
 * 并控制模型回复——用真实供应商既不可控也无法断言上下文内容。
 *
 * 不是 e2e-*.mjs，不会被 `npm run e2e` 收编（由具体脚本 import）。
 */
import { createServer } from 'node:http'

/**
 * @param {(body: any, request: any) => Promise<object>|object} handler
 *   返回 { text?, toolCalls?: [{id,name,arguments}], status?, error?, usage? }
 */
export async function startMockLlm(handler) {
  const requests = []
  let currentHandler = handler
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      void (async () => {
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'invalid json' } }))
          return
        }
        const entry = { body, at: Date.now() }
        requests.push(entry)
        let result
        try {
          result = await currentHandler(body, entry)
        } catch (error) {
          result = { status: 500, error: error instanceof Error ? error.message : String(error) }
        }
        if (result?.status && result.status >= 400) {
          res.writeHead(result.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result.body ?? { error: { message: result.error ?? 'mock error' } }))
          return
        }
        streamCompletion(res, result ?? {}, body?.model ?? 'mock-model')
      })()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setHandler(next) {
      currentHandler = next
    },
    reset() {
      requests.length = 0
    },
    /** 只取主对话请求（排除标题生成 / 记忆提取 / 摘要这三类小任务） */
    mainRequests() {
      return requests.filter((entry) => kindOf(entry.body) === 'chat')
    },
    byKind(kind) {
      return requests.filter((entry) => kindOf(entry.body) === kind)
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    }
  }
}

/** 按 system prompt 分辨请求类型：摘要 / 记忆提取 / 标题生成 / 主对话 */
export function kindOf(body) {
  const system = (body?.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
  const text = typeof system === 'string' ? system : JSON.stringify(system)
  if (text.includes('summarizing conversations')) return 'summary'
  if (text.includes('长期记忆整理器')) return 'memory'
  if (text.includes('标题生成器')) return 'title'
  return 'chat'
}

/** 把一条消息的文本内容拼出来（兼容 string 与 content 数组） */
export function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content.map((block) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('')
  }
  return ''
}

/** 非 system 消息的条数（"上下文里带了多少条历史"的断言口径） */
export function nonSystemMessages(body) {
  return (body?.messages ?? []).filter((m) => m.role !== 'system')
}

function streamCompletion(res, result, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const id = `chatcmpl-mock-${Math.random().toString(36).slice(2)}`
  const created = Math.floor(Date.now() / 1000)
  const send = (delta, finishReason = null, usage) => {
    const payload = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {})
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  send({ role: 'assistant', content: '' })
  if (result.text) send({ content: result.text })
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
    send({
      tool_calls: result.toolCalls.map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
      }))
    })
  }
  const usage = result.usage ?? {
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110
  }
  send({}, result.toolCalls?.length ? 'tool_calls' : 'stop', usage)
  res.write('data: [DONE]\n\n')
  res.end()
}
