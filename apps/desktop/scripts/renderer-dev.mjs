// 仅启动渲染层 Vite dev server（不构建 main/preload、不启动 Electron）：
// 供 headless Chrome 目检脚本（scripts/live2d-shot.mjs）使用，无需 Electron 二进制。
// electron-vite 的 --rendererOnly 仍会拉起 Electron，所以这里直接用 Vite API，
// 渲染层配置取自 electron.vite.config.ts（Node ≥22.18 原生剥离类型，可直接 import），保持单一来源。
//
// 用法（cwd = apps/desktop）：node scripts/renderer-dev.mjs [--port 5199]
import { createServer } from 'vite'

const portArg = process.argv.indexOf('--port')
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 5199

const { default: config } = await import('../electron.vite.config.ts')
const server = await createServer({
  ...config.renderer,
  configFile: false,
  server: { port, strictPort: true }
})
await server.listen()
server.printUrls()
