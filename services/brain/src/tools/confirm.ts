/**
 * bash 命令确认握手（进程内注册表，无持久化）：
 * execute 内 await 一个 promise，由渲染端 POST /api/tool-confirm 放行/拒绝；
 * 超时与回合中止自动拒绝。settled 幂等——迟到的回执返回 notFound。
 * 进程重启会丢失未决确认（SSE 断开，客户端自然结束回合），可接受。
 */

export type DeniedReason = 'blocked' | 'user_denied' | 'timeout' | 'aborted'

interface PendingConfirm {
  turnId: string
  toolCallId: string
  command: string
  expiresAt: number
  settled: boolean
  approve: () => void
  deny: (reason: DeniedReason) => void
  timer: NodeJS.Timeout
  onAbort: () => void
}

const key = (turnId: string, toolCallId: string): string => `${turnId}:${toolCallId}`

const pending = new Map<string, PendingConfirm>()

/** 拒绝原因的异常：execute 内抛出 → isError 工具结果（details.deniedReason 供渲染端） */
export class ToolDeniedError extends Error {
  readonly deniedReason: DeniedReason
  constructor(deniedReason: DeniedReason, message: string) {
    super(message)
    this.name = 'ToolDeniedError'
    this.deniedReason = deniedReason
  }
}

/**
 * 登记一个待确认命令。返回的 promise 批准为 true；拒绝/超时/中止以 ToolDeniedError reject。
 * 调用方负责在 promise 落定前把 tool_confirm 事件推给渲染端。
 */
export function requestBashConfirm(input: {
  turnId: string
  toolCallId: string
  command: string
  timeoutMs: number
  signal?: AbortSignal
}): { promise: Promise<boolean>; expiresAt: number } {
  const expiresAt = Date.now() + input.timeoutMs
  const k = key(input.turnId, input.toolCallId)

  // 释放型 settle：清 timer 与 abort 监听，幂等
  const settle = (fn: () => void): void => {
    const entry = pending.get(k)
    if (!entry || entry.settled) return
    entry.settled = true
    clearTimeout(entry.timer)
    input.signal?.removeEventListener('abort', entry.onAbort)
    pending.delete(k)
    fn()
  }

  const onAbort = (): void => {
    settle(() => deny('aborted'))
  }

  let approve!: () => void
  let deny!: (reason: DeniedReason) => void

  const promise = new Promise<boolean>((resolve, reject) => {
    approve = () => settle(() => resolve(true))
    deny = (reason) => settle(() => reject(new ToolDeniedError(reason, deniedMessage(reason))))
  })

  const timer = setTimeout(() => deny('timeout'), input.timeoutMs)
  input.signal?.addEventListener('abort', onAbort, { once: true })

  pending.set(k, {
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    command: input.command,
    expiresAt,
    settled: false,
    approve,
    deny,
    timer,
    onAbort
  })

  return { promise, expiresAt }
}

/** POST /api/tool-confirm 的回执入口 */
export function resolveBashConfirm(
  turnId: string,
  toolCallId: string,
  approved: boolean
): { ok: true; status: 'approved' | 'denied' } | { ok: false; status: 'notFound' } {
  const entry = pending.get(key(turnId, toolCallId))
  if (!entry || entry.settled) return { ok: false, status: 'notFound' }
  if (approved) entry.approve()
  else entry.deny('user_denied')
  return { ok: true, status: approved ? 'approved' : 'denied' }
}

/** 回合结束/中止时清理该 turnId 的全部未决确认（静默拒绝） */
export function rejectAllForTurn(turnId: string): void {
  for (const entry of pending.values()) {
    if (entry.turnId === turnId && !entry.settled) {
      entry.deny('aborted')
    }
  }
}

/** 拒绝原因 → LLM 可见消息（agentTurn 据此回推 details.deniedReason） */
export function deniedMessage(reason: DeniedReason): string {
  switch (reason) {
    case 'blocked':
      return '该命令被安全策略禁止'
    case 'user_denied':
      return '用户拒绝了执行该命令'
    case 'timeout':
      return '等待确认超时，已自动拒绝执行该命令'
    case 'aborted':
      return '回合已中止，命令未执行'
  }
}
