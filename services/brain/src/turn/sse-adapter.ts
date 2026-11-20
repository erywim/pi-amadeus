import type { SseEvent } from '@pi-amadeus/shared'
import type { TurnEvent } from './contracts.ts'

const RESULT_LIMIT = 4000
const truncate = (text: string): string => text.length <= RESULT_LIMIT ? text : `${text.slice(0, RESULT_LIMIT)}…（已截断）`

/** 仅在传输边界裁剪摘要；完整工具结果仍留给模型。内部审批落定事件不扩展 SSE 词汇。 */
export function toSseEvent(event: TurnEvent, turnId: string, labels: ReadonlyMap<string, string>): SseEvent | undefined {
  switch (event.type) {
    case 'approval_settled': return undefined
    case 'delta':
    case 'computer_request': return event
    case 'tool_start': return { ...event, turnId, label: labels.get(event.toolName) ?? event.toolName }
    case 'tool_update': return { ...event, turnId, partial: truncate(event.partial) }
    case 'tool_end': return { ...event, turnId, result: truncate(event.result) }
    case 'tool_confirm': return { ...event, turnId }
  }
}
