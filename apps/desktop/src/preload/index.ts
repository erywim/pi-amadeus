import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type AppMode = 'window' | 'pet'

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
  setUiLanguage: (lang: string): void => ipcRenderer.send('app:ui-language', lang),
  getMode: (): Promise<AppMode> => ipcRenderer.invoke('mode:get'),
  setMode: (mode: AppMode): void => ipcRenderer.send('mode:set', mode),
  onModeChanged: (callback: (mode: AppMode) => void): (() => void) => subscribe('mode:changed', callback),
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
  ...(import.meta.env.DEV
    ? {
        debug: {
          state: (): Promise<unknown> => ipcRenderer.invoke('debug:state'),
          petCursor: (point: { x: number; y: number } | null): Promise<void> => ipcRenderer.invoke('debug:pet-cursor', point),
          petPassthrough: (forced: boolean): Promise<void> => ipcRenderer.invoke('debug:pet-passthrough', forced)
        }
      }
    : {})
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
