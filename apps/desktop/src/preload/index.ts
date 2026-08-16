import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('app:platform')
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
