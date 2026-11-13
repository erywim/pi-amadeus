import { create } from 'zustand'

/** 左侧配置面板的标签页 */
export type ConfigPanelTab = 'avatar' | 'expressions' | 'ai'

/** Live2D 场景页的 UI 层状态：覆盖层 / 对话框 / 调试输入框 */
interface UiState {
  /** 登录覆盖层（数字雨）是否可见 */
  loginOpen: boolean
  username: string | null
  /** 左侧配置面板 */
  configPanelOpen: boolean
  configPanelTab: ConfigPanelTab
  /** 聊天记录弹窗 */
  chatHistoryOpen: boolean
  /** 底部对话框的转写文字 */
  dialogText: string
  /** 调试输入框内容 */
  debugText: string
  /** 麦克风是否开启（实时语音监听中） */
  micActive: boolean
  /** 摄像头是否开启（视觉帧采集中） */
  cameraActive: boolean
  /** 静音语音播报（TTS 播放与入队全部关闭） */
  ttsMuted: boolean
  /** 全局命令面板（⌘K）是否打开 */
  commandPaletteOpen: boolean
  /** 消息分支树弹窗是否打开 */
  branchTreeOpen: boolean
  /** 快捷键速查弹窗是否打开 */
  shortcutsOpen: boolean
  /** 请求在右侧工作区面板里打开某个文件的 diff（消息里的改动卡用） */
  workspaceDiffRequest: { path: string; nonce: number } | null

  openLogin: () => void
  closeLogin: () => void
  setUsername: (username: string | null) => void
  setConfigPanelOpen: (open: boolean, tab?: ConfigPanelTab) => void
  setChatHistoryOpen: (open: boolean) => void
  setDialogText: (text: string) => void
  setDebugText: (text: string) => void
  setMicActive: (active: boolean) => void
  setCameraActive: (active: boolean) => void
  setTtsMuted: (muted: boolean) => void
  setCommandPaletteOpen: (open: boolean) => void
  setBranchTreeOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
  requestWorkspaceDiff: (path: string) => void
  clearWorkspaceDiffRequest: () => void
}

export const useUiStore = create<UiState>()((set) => ({
  loginOpen: false,
  username: null,
  configPanelOpen: false,
  configPanelTab: 'avatar',
  chatHistoryOpen: false,
  dialogText: '',
  debugText: '',
  micActive: false,
  cameraActive: false,
  ttsMuted: false,
  commandPaletteOpen: false,
  branchTreeOpen: false,
  shortcutsOpen: false,
  workspaceDiffRequest: null,

  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),
  setUsername: (username) => set({ username }),
  setConfigPanelOpen: (open, tab) =>
    set((s) => ({ configPanelOpen: open, configPanelTab: tab ?? s.configPanelTab })),
  setChatHistoryOpen: (open) => set({ chatHistoryOpen: open }),
  setDialogText: (dialogText) => set({ dialogText }),
  setDebugText: (debugText) => set({ debugText }),
  setMicActive: (micActive) => set({ micActive }),
  setCameraActive: (cameraActive) => set({ cameraActive }),
  setTtsMuted: (ttsMuted) => set({ ttsMuted }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setBranchTreeOpen: (branchTreeOpen) => set({ branchTreeOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  requestWorkspaceDiff: (path) =>
    set({ workspaceDiffRequest: { path, nonce: Date.now() } }),
  clearWorkspaceDiffRequest: () => set({ workspaceDiffRequest: null })
}))
