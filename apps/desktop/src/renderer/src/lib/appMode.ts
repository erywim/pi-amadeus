import { stopCamera } from './camera'
import { stopAssistantVoiceTurn, stopMic } from './voice'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/**
 * 主窗口对模式切换的响应：
 * - 进入桌宠模式：主窗口被隐藏，停掉本窗口的麦克风 / 语音回合 / 摄像头——
 *   麦克风与播报由桌宠窗口接管，不留一个看不见的窗口还在收音或说话。
 * - 回到窗口模式：桌宠窗口里的语音回合已落库到服务端，刷新当前会话与列表，
 *   主窗口立刻能看到这轮对话。
 */
export function bindMainWindowToAppMode(): void {
  window.api?.onModeChanged((mode) => {
    if (mode === 'pet') {
      stopMic()
      stopAssistantVoiceTurn()
      stopCamera()
      const ui = useUiStore.getState()
      ui.setMicActive(false)
      ui.setCameraActive(false)
      useCompanionStore.getState().setPendingUser(null)
      return
    }
    const { activeSessionId, refreshSession, refreshSessions } = useSessionStore.getState()
    if (activeSessionId) void refreshSession(activeSessionId)
    else void refreshSessions()
  })
}
