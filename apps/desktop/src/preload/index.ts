import type { ProactiveMessageEvent } from '@pi-amadeus/shared'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ComputerAction } from '@pi-amadeus/shared'

type AppMode = 'window' | 'pet'

/** 主动问候的配置补丁（渲染层 → 主进程；字段由主进程逐个校验） */
interface ProactiveConfigPatch {
  enabled?: boolean
  userId?: string | null
  sessionId?: string | null
  brainUrl?: string
  busy?: boolean
  modelKey?: string
}

/** 订阅主进程推送，返回取消订阅函数 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('app:platform'),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
  computer: {
    execute: (action: ComputerAction): Promise<unknown> => ipcRenderer.invoke('computer:execute', action)
  },
  setUiLanguage: (lang: string): void => ipcRenderer.send('app:ui-language', lang),
  getMode: (): Promise<AppMode> => ipcRenderer.invoke('mode:get'),
  setMode: (mode: AppMode): void => ipcRenderer.send('mode:set', mode),
  onModeChanged: (callback: (mode: AppMode) => void): (() => void) => subscribe('mode:changed', callback),
  agents: {
    request: (path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> =>
      ipcRenderer.invoke('agents:request', path, method, body),
    subscribe: (userId: string, after: number, onChunk: (chunk: string) => void, onEnd: () => void): (() => void) => {
      const id = crypto.randomUUID()
      const removeChunk = subscribe<{ id: string; chunk: string }>('agents:chunk', (payload) => {
        if (payload.id === id) onChunk(payload.chunk)
      })
      const removeEnd = subscribe<{ id: string }>('agents:end', (payload) => {
        if (payload.id === id) onEnd()
      })
      ipcRenderer.send('agents:subscribe', id, userId, after)
      return () => {
        removeChunk()
        removeEnd()
        ipcRenderer.send('agents:unsubscribe', id)
      }
    }
  },
  pet: {
    ready: (): void => ipcRenderer.send('pet:ready'),
    openMenu: (): void => ipcRenderer.send('pet:menu'),
    setInteractive: (interactive: boolean): void => ipcRenderer.send('pet:set-interactive', interactive),
    /** 兜底 logo 命中：强制穿透时也只有这里能接管鼠标 */
    setEscape: (escape: boolean): void => ipcRenderer.send('pet:set-escape', escape),
    /** 开关强制穿透（兜底 logo 的菜单） */
    setPassthrough: (forced: boolean): void => ipcRenderer.send('pet:set-passthrough', forced),
    onCursor: (callback: (point: { x: number; y: number }) => void): (() => void) => subscribe('pet:cursor', callback),
    onPassthrough: (callback: (forced: boolean) => void): (() => void) => subscribe('pet:passthrough', callback)
  },
  /**
   * 主动问候：开关/身份/会话/忙碌上报给主进程；问候由主进程经 onMessage 推回。
   * 只做通道，不做判断——怎么触发由主进程的调度器决定。
   */
  proactive: {
    setConfig: (patch: ProactiveConfigPatch): void => ipcRenderer.send('proactive:config', patch),
    /** 屏幕录制权限（macOS）：granted / denied / not-determined … */
    permission: (): Promise<string> => ipcRenderer.invoke('proactive:permission'),
    /** 用户刚打开开关时触发一次系统授权（macOS）；返回触发后的权限状态 */
    requestPermission: (): Promise<string> => ipcRenderer.invoke('proactive:request-permission'),
    onMessage: (callback: (message: ProactiveMessageEvent) => void): (() => void) =>
      subscribe('proactive:message', callback)
  },
  ...(import.meta.env.DEV
    ? {
        debug: {
          state: (): Promise<unknown> => ipcRenderer.invoke('debug:state'),
          petCursor: (point: { x: number; y: number } | null): Promise<void> => ipcRenderer.invoke('debug:pet-cursor', point),
          petPassthrough: (forced: boolean): Promise<void> => ipcRenderer.invoke('debug:pet-passthrough', forced),
          /** 主动问候 e2e：state / trigger / frame / eligible / brain */
          proactive: (command: Record<string, unknown>): Promise<unknown> =>
            ipcRenderer.invoke('debug:proactive', command)
        }
      }
    : {})
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
