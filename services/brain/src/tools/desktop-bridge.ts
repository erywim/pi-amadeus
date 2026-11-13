import { randomUUID } from 'node:crypto'
import type { ComputerAction, ComputerRequest, ComputerResult } from '@pi-amadeus/shared'
import type { SseEvent } from '@pi-amadeus/shared'

export interface DesktopBridgeOptions {
  turnId: string
  signal?: AbortSignal
  timeoutMs: number
  push: (event: SseEvent) => void
}

interface Pending {
  request: ComputerRequest
  timer: NodeJS.Timeout
  settled: boolean
  resolve: (result: ComputerResult) => void
  reject: (error: Error) => void
  onAbort: () => void
}

export interface DesktopBridgeResult {
  result: ComputerResult
  request: ComputerRequest
}

/**
 * Brain 与 Electron renderer 的一次性 rendezvous。
 * 状态只在当前进程内存在：SSE 断开、回合中止或超时都会释放 pending，迟到回执不能复活回合。
 */
export class DesktopBridge {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  private readonly opts: DesktopBridgeOptions

  constructor(opts: DesktopBridgeOptions) {
    this.opts = opts
  }

  request(toolCallId: string, action: ComputerAction): Promise<DesktopBridgeResult> {
    if (this.closed || this.opts.signal?.aborted) return Promise.reject(new Error('computer 回合已结束'))
    if (this.pending.size > 0) return Promise.reject(new Error('computer 动作必须串行执行'))

    const request: ComputerRequest = {
      type: 'computer_request',
      turnId: this.opts.turnId,
      toolCallId,
      requestId: randomUUID(),
      action: action.action,
      args: action,
      // 截图也属于敏感的外发动作：每一步都由用户确认，避免模型静默读取屏幕。
      requiresConfirmation: true,
      expiresAt: Date.now() + this.opts.timeoutMs
    }

    return new Promise<DesktopBridgeResult>((resolve, reject) => {
      const onAbort = (): void => this.settle(request.requestId, new Error('computer 回合已中止'))
      const timer = setTimeout(() => this.settle(request.requestId, new Error('computer 动作等待超时')), this.opts.timeoutMs)
      this.pending.set(request.requestId, { request, timer, settled: false, resolve: (result) => resolve({ result, request }), reject, onAbort })
      this.opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.opts.push(request as unknown as SseEvent)
    })
  }

  resolve(result: ComputerResult): { ok: true } | { ok: false; status: 'notFound' | 'invalid' } {
    const pending = this.pending.get(result.requestId)
    if (!pending || pending.settled) return { ok: false, status: 'notFound' }
    if (
      result.turnId !== this.opts.turnId ||
      result.toolCallId !== pending.request.toolCallId ||
      result.requestId !== pending.request.requestId
    ) {
      return { ok: false, status: 'invalid' }
    }
    if (!result.approved && !result.error) {
      return { ok: false, status: 'invalid' }
    }
    this.settle(result.requestId, undefined, result)
    return { ok: true }
  }

  /** AgentTool 创建后再绑定真实 toolCallId，避免把它放入 action 参数。 */
  bindToolCall(requestId: string, toolCallId: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.settled) return false
    pending.request.toolCallId = toolCallId
    return true
  }

  turnId(): string {
    return this.opts.turnId
  }

  close(): void {
    this.closed = true
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, new Error('computer 回合已结束'))
  }

  private settle(requestId: string, error?: Error, result?: ComputerResult): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    this.opts.signal?.removeEventListener('abort', pending.onAbort)
    this.pending.delete(requestId)
    if (error) pending.reject(error)
    else if (result) pending.resolve(result)
  }
}

const bridges = new Map<string, DesktopBridge>()

export function registerDesktopBridge(bridge: DesktopBridge): void {
  bridges.set(bridgeId(bridge), bridge)
}

export function unregisterDesktopBridge(turnId: string): void {
  const bridge = bridges.get(turnId)
  bridge?.close()
  bridges.delete(turnId)
}

export function resolveDesktopResult(result: ComputerResult): { ok: true } | { ok: false; status: 'notFound' | 'invalid' } {
  const bridge = bridges.get(result.turnId)
  return bridge ? bridge.resolve(result) : { ok: false, status: 'notFound' }
}

function bridgeId(bridge: DesktopBridge): string {
  return bridge.turnId()
}
