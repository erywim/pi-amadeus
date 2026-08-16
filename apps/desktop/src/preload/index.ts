import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('app:platform'),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path)
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
