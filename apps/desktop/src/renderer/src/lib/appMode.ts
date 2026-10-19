import { stopCamera } from './camera'
import { stopAssistantVoiceTurn, stopMic } from './voice'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/**
 * 主窗口对模式切换的响应：进入桌宠模式时主窗口被隐藏，
 * 停掉本窗口的麦克风 / 语音回合 / 摄像头——麦克风与播报由桌宠窗口接管，
 * 不留一个看不见的窗口还在收音或说话。
 */
export function bindMainWindowToAppMode(): void {
  window.api?.onModeChanged((mode) => {
    if (mode !== 'pet') return
    stopMic()
    stopAssistantVoiceTurn()
    stopCamera()
    const ui = useUiStore.getState()
    ui.setMicActive(false)
    ui.setCameraActive(false)
    useCompanionStore.getState().setPendingUser(null)
  })
}
