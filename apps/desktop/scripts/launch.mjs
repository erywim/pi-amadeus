// electron-vite 启动包装：VSCode 扩展宿主环境会设置 ELECTRON_RUN_AS_NODE=1，
// 导致 electron.exe 以纯 Node 模式启动（无 Electron API、--version 打印
// Node 版本）。剥离该变量后再启动，保证任何环境下 npm run dev 行为一致。
import { spawn } from 'node:child_process'

const command = process.argv[2]
if (!command) {
  console.error('usage: node scripts/launch.mjs <electron-vite command>')
  process.exit(1)
}

delete process.env.ELECTRON_RUN_AS_NODE

const child = spawn('electron-vite', [command], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
