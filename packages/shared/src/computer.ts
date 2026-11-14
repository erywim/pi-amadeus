/**
 * Computer Use 的跨端动作协议。
 * 坐标沿用 OpenAI computer tool 的整数像素语义；桌面端执行器负责把截图像素
 * 映射到当前 Electron 窗口的 CSS viewport，避免 brain 直接接触 Electron API。
 */

export type ComputerActionName =
  | 'click'
  | 'double_click'
  | 'drag'
  | 'keypress'
  | 'move'
  | 'screenshot'
  | 'scroll'
  | 'type'
  | 'wait'

export type ComputerMouseButton = 'left' | 'middle' | 'right'

export interface ComputerPoint {
  x: number
  y: number
}

export interface ComputerAction {
  action: ComputerActionName
  x?: number
  y?: number
  button?: ComputerMouseButton
  path?: ComputerPoint[]
  keys?: string[]
  scroll_x?: number
  scroll_y?: number
  text?: string
}

/** brain 发给 renderer 的一次性执行请求；图片不走 SSE，避免重复传输。 */
export interface ComputerRequest {
  type: 'computer_request'
  turnId: string
  toolCallId: string
  requestId: string
  action: ComputerActionName
  args: ComputerAction
  requiresConfirmation: boolean
  expiresAt: number
}

export interface ComputerScreenshot {
  data: string
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  surface: 'window'
}

/** renderer 执行后回传 brain 的结果；approved=false 时不得带截图。 */
export interface ComputerResult {
  turnId: string
  toolCallId: string
  requestId: string
  approved: boolean
  screenshot?: ComputerScreenshot
  error?: {
    code: 'user_denied' | 'timeout' | 'aborted' | 'unsupported' | 'permission_denied' | 'invalid_args' | 'execution_failed'
    message: string
  }
}

/** Electron 主进程返回给 renderer 的可序列化执行结果。 */
export interface ComputerExecutionResult {
  ok: boolean
  screenshot?: ComputerScreenshot
  error?: {
    code: Exclude<NonNullable<ComputerResult['error']>['code'], 'user_denied' | 'timeout' | 'aborted'>
    message: string
  }
}
