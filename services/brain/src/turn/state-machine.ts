/** 回合状态机只接受领域事件，不依赖模型、工具、SSE 或持久化。 */
export type TurnStatus = 'preparing' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'

export interface TurnState {
  status: TurnStatus
  /** pi 允许同批工具并发审批，不能因其中一个落定就把其它待确认项抹掉。 */
  pendingApprovals: readonly string[]
}

export type TurnStateEvent =
  | { type: 'start' }
  | { type: 'approval_requested'; toolCallId: string }
  | { type: 'approval_settled'; toolCallId: string }
  | { type: 'complete' | 'fail' | 'cancel' }

export function initialTurnState(): TurnState {
  return { status: 'preparing', pendingApprovals: [] }
}

export function isTurnFinal(state: TurnState): boolean {
  return state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled'
}

export function transitionTurn(state: TurnState, event: TurnStateEvent): TurnState {
  // 终态不再迁移：取消后的迟到确认/模型结束事件不能把回合复活。
  if (isTurnFinal(state)) return state
  if (event.type === 'cancel' || event.type === 'fail') {
    // 任意活动态 → 取消/失败，同时清掉审批投影；副作用由组合根负责收尾。
    return { status: event.type === 'cancel' ? 'cancelled' : 'failed', pendingApprovals: [] }
  }
  if (event.type === 'start' && state.status === 'preparing') {
    // 准备完成 → running，模型执行前才开放工具事件。
    return { status: 'running', pendingApprovals: [] }
  }
  if (event.type === 'approval_requested' && state.status !== 'preparing') {
    // running/等待确认 → waiting_approval；重复登记保持幂等，不丢并发审批。
    return { status: 'waiting_approval', pendingApprovals: [...new Set([...state.pendingApprovals, event.toolCallId])] }
  }
  if (event.type === 'approval_settled' && state.pendingApprovals.includes(event.toolCallId)) {
    const pendingApprovals = state.pendingApprovals.filter((id) => id !== event.toolCallId)
    // 最后一项确认落定 → running；旧工具回执不能放行其它仍待确认的调用。
    return { status: pendingApprovals.length ? 'waiting_approval' : 'running', pendingApprovals }
  }
  // 只有执行态且没有待确认项才能完成；准备中或审批中收到的 complete 不是成功。
  if (event.type === 'complete' && state.status === 'running') return { status: 'completed', pendingApprovals: [] }
  return state
}
