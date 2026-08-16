/// <reference types="vite/client" />

declare global {
  interface Window {
    /** Live2D 引擎调试钩子（/live2d 页面挂载期间存在，验证清单用） */
    __live2d?: import('./features/live2d/lib/live2d-engine').Live2DEngine
  }
}

export {}
