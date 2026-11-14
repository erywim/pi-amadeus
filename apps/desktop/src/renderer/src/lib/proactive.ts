import toast from 'react-hot-toast'
import { normalizeEmotion } from '@pi-amadeus/shared'
import type { ProactiveMessageEvent } from '@pi-amadeus/shared'
import { BRAIN_URL } from './api'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { activeProviderOf, useProviderStore } from '@renderer/stores/providerStore'
import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore } from '@renderer/stores/uiStore'

/**
 * 主动问候的渲染层接线（主窗口与桌宠窗口共用）：
 * - 上报配置：开关（设置页）、身份/当前会话、大脑地址、是否正忙；
 * - 接收问候：写进对话文本（桌宠对话框 / 陪伴页）、切表情、刷新会话，
 *   主窗口另外弹一个 toast（窗口在后台时用户主要靠系统通知）。
 *
 * 什么时候触发、截哪块屏、发不发通知，全部在主进程（main/proactive.ts）；
 * 这里不做判断，只把用户可见的状态接上。
 */

const isPetWindow = new URLSearchParams(window.location.search).get('window') === 'pet'

/** 当前是否有正在进行的对话（麦克风 / 语音回合 / 文本回合）：有就不打断 */
function isTurnActive(): boolean {
  return (
    useUiStore.getState().micActive ||
    useLive2dSpeechStore.getState().voiceActive ||
    useSessionStore.getState().stream.streaming
  )
}

/** 问候到达：当成她主动开启的一轮对话 */
export function handleProactiveMessage(message: ProactiveMessageEvent): void {
  // 新一轮：桌宠对话框即便上一轮被手动收起，也要重新出现
  useCompanionStore.getState().showProactive()
  // 回合进行中不抢对话文本（问候仍已落库，稍后能在消息列表看到）
  if (!isTurnActive()) useUiStore.getState().setDialogText(message.text)
  const emotion = normalizeEmotion(message.emotion)
  if (emotion) useLive2dStore.getState().setEmotion(emotion)

  // 服务端已把问候写进会话：无论当前是否正在看另一条会话，都先刷新目标缓存，
  // 否则该会话如果之前加载过，selectSession 的懒加载会误以为缓存仍然最新。
  const session = useSessionStore.getState()
  void session.refreshSession(message.sessionId)
  if (session.activeSessionId !== message.sessionId) void session.refreshSessions()

  // 桌宠窗口里对话框会自己出现；主窗口没有常驻对话气泡，用 toast 提示
  if (!isPetWindow) toast(message.text, { duration: 8000 })
}

export function bindProactive(): void {
  const api = window.api?.proactive
  if (!api) return

  // 两个窗口都会上报；内容没变就不发 IPC
  // （文本流式期间 store 每次增量都会触发订阅，这里做去重）
  let lastPayload = ''
  const report = (): void => {
    const session = useSessionStore.getState()
    const active = session.sessions.find((item) => item.id === session.activeSessionId)
    const persistedDesktopSession =
      active && active.channel === 'desktop' && !active.localOnly ? active.id : null
    const activeProvider = activeProviderOf(useProviderStore.getState().providers)
    const modelKey = activeProvider
      ? `${activeProvider.id}|${activeProvider.baseUrl}|${activeProvider.model}`
      : `builtin|${useSettingsStore.getState().aiConfig.provider.baseUrl}|${useSettingsStore.getState().aiConfig.provider.model}`
    const payload = {
      enabled: useSettingsStore.getState().proactiveEnabled,
      userId: session.userId,
      sessionId: persistedDesktopSession,
      brainUrl: BRAIN_URL,
      busy: isTurnActive(),
      modelKey
    }
    const key = JSON.stringify(payload)
    if (key === lastPayload) return
    lastPayload = key
    api.setConfig(payload)
  }

  report()
  useSessionStore.subscribe(report)
  useUiStore.subscribe(report)
  useLive2dSpeechStore.subscribe(report)
  useSettingsStore.subscribe(report)

  api.onMessage(handleProactiveMessage)
}
