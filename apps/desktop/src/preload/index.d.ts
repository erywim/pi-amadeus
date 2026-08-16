export type DesktopApi = {
  getVersion: () => Promise<string>
  getPlatform: () => Promise<string>
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
