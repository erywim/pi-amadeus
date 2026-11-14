import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * 最小 MCP（Model Context Protocol）stdio 客户端。
 *
 * 不引第三方 SDK：stdio 传输就是「一行一个 JSON-RPC 2.0 消息」，
 * 需要的能力只有 initialize / tools/list / tools/call 三个方法。
 * 服务端进程由用户显式安装的插件配置启动——这里不做任何来源信任判断。
 */

export interface McpServerSpec {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

export interface McpToolResult {
  content: McpContentBlock[]
  isError?: boolean
  structuredContent?: unknown
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/** 初始化可能要等 npx 首次下载包，给足时间；工具调用给更长的执行窗口 */
const INIT_TIMEOUT_MS = 90_000
const LIST_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 180_000
const STDERR_TAIL = 4000

export class McpStdioClient {
  readonly spec: McpServerSpec
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private buffer = ''
  private stderrTail = ''
  private closed = false
  private initialized = false
  private readonly onClose?: (error: Error) => void

  constructor(spec: McpServerSpec, onClose?: (error: Error) => void) {
    this.spec = spec
    this.onClose = onClose
  }

  get isReady(): boolean {
    return this.initialized && !this.closed
  }

  async connect(): Promise<void> {
    if (this.proc) return
    const proc = spawn(this.spec.command, this.spec.args, {
      // 继承大脑进程环境（PATH 等），再叠加插件自己的变量
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)
    })
    proc.on('error', (error) => {
      this.failConnection(new Error(`MCP 服务启动失败（${this.spec.command}）：${error.message}`))
    })
    proc.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim()
      this.failConnection(
        new Error(
          `MCP 服务已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）${
            tail ? `：${tail.slice(-400)}` : ''
          }`
        )
      )
    })

    await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'amadeus', version: '0.1.0' }
      },
      INIT_TIMEOUT_MS
    )
    this.notify('notifications/initialized', {})
    this.initialized = true
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {}, LIST_TIMEOUT_MS)) as {
      tools?: McpTool[]
    } | null
    return Array.isArray(result?.tools) ? result.tools : []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.request(
      'tools/call',
      { name, arguments: args },
      CALL_TIMEOUT_MS
    )) as Partial<McpToolResult> | null
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: result?.isError === true,
      structuredContent: result?.structuredContent
    }
  }

  close(): void {
    // 主动断开 → 关闭；不触发故障通知，避免停用/卸载后又被退出事件标成 error。
    this.closed = true
    this.initialized = false
    this.failAll(new Error('MCP 连接已关闭'))
    const proc = this.proc
    this.proc = null
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM')
      // 宽限期后强杀：服务端可能忽略 SIGTERM
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }, 2000)
      timer.unref()
    }
  }

  // ---------- JSON-RPC ----------

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.proc || this.closed) return Promise.reject(new Error('MCP 连接未建立'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} 超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: unknown): void {
    const proc = this.proc
    if (!proc || proc.stdin.destroyed) return
    proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        // 非 JSON 输出（部分服务会往 stdout 打日志）：忽略，不影响协议帧
        continue
      }
      this.onMessage(message)
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = typeof message.id === 'number' ? message.id : undefined
    // 服务端 → 客户端请求（sampling / roots 等）：明确回不支持，避免对方挂起
    if (id !== undefined && typeof message.method === 'string') {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Amadeus 不支持 ${String(message.method)}` }
      })
      return
    }
    if (id === undefined) return // 通知（notifications/*）无需处理
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error) {
      const error = message.error as { message?: string; code?: number }
      pending.reject(new Error(`MCP ${pending.method} 失败：${error.message ?? JSON.stringify(error)}`))
      return
    }
    pending.resolve(message.result)
  }

  private failConnection(error: Error): void {
    if (this.closed) return
    // 进程退出/启动失败 → 不可用；先撤销 ready，再通知管理器清除状态和工具。
    this.closed = true
    this.initialized = false
    this.failAll(error)
    this.onClose?.(error)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
