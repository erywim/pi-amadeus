import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AgentProfileInput, AgentTaskEvent, AgentTaskInput } from '@pi-amadeus/shared'
import { AgentError, AgentManager, agentObject, agentPosition, agentString } from '../agents/manager.ts'
import { AgentStore } from '../agents/store.ts'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const PROFILE_FIELDS = ['name', 'runtime', 'command', 'args', 'promptMode', 'instructions', 'model', 'enabled', 'allowRemote']

/** 原生 IPC 无 Origin；浏览器只接受 loopback 来源，null/file 由原生桥接处理。 */
function localRequest(c: Context): boolean {
  try {
    const host = c.req.header('host')
    if (!host || !LOOPBACK.has(new URL(`http://${host}`).hostname) || /[\s/@\\]/.test(host)) return false
    if (!LOOPBACK.has(new URL(c.req.url).hostname)) return false
    const origin = c.req.header('origin')
    if (!origin) return true
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname) && url.origin === origin
  } catch { return false }
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const length = c.req.header('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > 1_048_576)) throw new AgentError(400, '请求体不能超过 1 MiB')
  // 流式限额覆盖 chunked 请求，不能等 c.req.json() 已分配任意大的内存之后才校验。
  const reader = c.req.raw.body?.getReader()
  if (!reader) throw new AgentError(400, '缺少 JSON 请求体')
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 1_048_576) {
        await reader.cancel()
        throw new AgentError(400, '请求体不能超过 1 MiB')
      }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  try { return agentObject(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch (error) {
    if (error instanceof AgentError) throw error
    throw new AgentError(400, '请求体不是有效的 JSON')
  }
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new AgentError(400, '请求包含不支持的字段')
}

/** SSE 只订阅已落库事件；慢客户端关闭重连，绝不反向取消 manager 的执行。 */
function eventsResponse(c: Context, store: AgentStore, userId: string, after: number): Response {
  const encoder = new TextEncoder()
  let cleanup = (): void => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let cursor = after
      const close = (): void => {
        if (closed) return
        // 订阅中 → 断开：只清理本观察者的 heartbeat/listener，执行由 manager 独立管理。
        closed = true
        cleanup()
        try { controller.close() } catch { /* cancel 已先关闭流。 */ }
      }
      const send = (text: string): void => {
        if (closed) return
        if ((controller.desiredSize ?? 0) <= 0) { close(); return }
        try { controller.enqueue(encoder.encode(text)) } catch { close() }
      }
      const emit = (event: AgentTaskEvent, snapshot = false): void => {
        if (!snapshot && event.seq <= cursor) return
        cursor = event.seq
        send(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      const onAbort = (): void => close()
      const unsubscribe = store.subscribe((owner, event) => {
        if (owner === userId) emit(event)
      })
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15_000)
      cleanup = () => {
        unsubscribe()
        clearInterval(heartbeat)
        c.req.raw.signal.removeEventListener('abort', onAbort)
      }
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true })
      if (c.req.raw.signal.aborted) { close(); return }
      try {
        const history = store.listEvents(userId, 0)
        const newest = history.at(-1)?.seq ?? 0
        const oldest = history[0]?.seq ?? 0
        if (after === 0 || after > newest || (oldest > 0 && after < oldest)) {
          // 初连/历史已压缩 → 一次持久化快照重同步，cursor 取同一时刻日志尾，不漏后续 live 事件。
          emit({ seq: newest, taskId: '', type: 'status', data: { resync: true, tasks: store.listTasks(userId) }, createdAt: Date.now() }, true)
        } else {
          for (const event of history) if (event.seq > after) emit(event)
        }
      } catch { close() }
    },
    cancel() { cleanup() }
  }, { highWaterMark: 1024 * 1024, size: (chunk) => chunk.byteLength })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } })
}

export function agentRoutes(manager: AgentManager, store: AgentStore): Hono {
  const app = new Hono()
  app.use('/agents/*', async (c, next) => {
    if (!localRequest(c)) return c.json({ error: 'Agent 本机接口仅接受 loopback Host 和本机 Origin；远程请使用已配对协同入口' }, 400)
    await next()
  })
  app.use('/agents', async (c, next) => {
    if (!localRequest(c)) return c.json({ error: 'Agent 本机接口仅接受 loopback Host 和本机 Origin' }, 400)
    await next()
  })
  app.onError((error, c) => {
    if (error instanceof AgentError) return c.json({ error: error.message }, error.status)
    console.error('[agents] API 失败：', error.message)
    return c.json({ error: 'Agent 操作失败，持久化记录未被清空，请检查服务日志' }, 500)
  })

  app.get('/agents', async (c) => c.json(await manager.overview(agentString(c.req.query('userId'), 'userId'))))

  app.get('/agents/events', (c) => {
    const userId = agentString(c.req.query('userId'), 'userId')
    const value = c.req.query('after') ?? c.req.header('last-event-id') ?? '0'
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AgentError(400, 'after 必须为非负安全整数')
    return eventsResponse(c, store, userId, Number(value))
  })

  app.get('/agents/tasks/:id', (c) => c.json({ task: manager.getTask(c.req.param('id'), agentString(c.req.query('userId'), 'userId')) }))

  app.post('/agents/tasks', async (c) => {
    const body = await jsonBody(c)
    fields(body, ['userId', 'agentId', 'title', 'prompt', 'cwd', 'missionId', 'parentTaskId', 'resumeOf', 'dependsOn', 'requestId'])
    return c.json({ task: await manager.createTask(body as unknown as AgentTaskInput) }, 201)
  })

  app.post('/agents/tasks/:id/stop', async (c) => {
    const body = await jsonBody(c)
    fields(body, ['userId'])
    return c.json({ task: await manager.stop(c.req.param('id'), agentString(body.userId, 'userId')) })
  })

  app.post('/agents/tasks/:id/resume', async (c) => {
    const body = await jsonBody(c)
    fields(body, ['userId', 'prompt', 'requestId', 'agentId'])
    const prompt = body.prompt === undefined ? '' : agentString(body.prompt, 'prompt', 64_000, true)
    const agentId = body.agentId === undefined ? undefined : agentString(body.agentId, 'agentId')
    return c.json({ task: await manager.resume(c.req.param('id'), agentString(body.userId, 'userId'), prompt, agentString(body.requestId, 'requestId'), agentId) }, 201)
  })

  app.post('/agents/tasks/:id/approve', async (c) => {
    const body = await jsonBody(c)
    fields(body, ['userId', 'approved', 'turnId', 'toolCallId'])
    if (typeof body.approved !== 'boolean') throw new AgentError(400, 'approved 必须为布尔值')
    const turnId = agentString(body.turnId, 'turnId', 256)
    const toolCallId = agentString(body.toolCallId, 'toolCallId', 256)
    return c.json({ task: await manager.approve(c.req.param('id'), agentString(body.userId, 'userId'), body.approved, { turnId, toolCallId }) })
  })

  app.patch('/agents/tasks/:id/position', async (c) => {
    const body = await jsonBody(c)
    fields(body, ['userId', 'position', 'revision'])
    if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision)) throw new AgentError(400, 'revision 必须为整数')
    return c.json({ task: manager.move(c.req.param('id'), agentString(body.userId, 'userId'), agentPosition(body.position), body.revision) })
  })

  app.post('/agents/profiles', async (c) => {
    const body = await jsonBody(c)
    fields(body, PROFILE_FIELDS)
    return c.json({ profile: await manager.saveProfile(body as unknown as AgentProfileInput) }, 201)
  })

  app.patch('/agents/profiles/:id', async (c) => {
    const body = await jsonBody(c)
    fields(body, PROFILE_FIELDS)
    const previous = store.getProfile(c.req.param('id'))
    if (!previous) throw new AgentError(404, 'Agent 配置不存在')
    return c.json({ profile: await manager.saveProfile({ ...previous, ...body } as AgentProfileInput, previous.id) })
  })

  app.delete('/agents/profiles/:id', (c) => {
    manager.deleteProfile(c.req.param('id'))
    return c.json({ ok: true })
  })

  return app
}
