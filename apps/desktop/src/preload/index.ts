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
  petReady: (): void => ipcRenderer.send('pet:ready'),
  ...(import.meta.env.DEV ? { debugState: (): Promise<unknown> => ipcRenderer.invoke('debug:state') } : {})
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
