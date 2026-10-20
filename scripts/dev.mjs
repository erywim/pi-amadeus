/**
 * 一键启动前后端：brain 服务（node --watch, 端口 3002）+ 桌面端（electron-vite dev）。
 *
 * 前置检查（不通过只警告不阻止，除了缺依赖）：
 * - Node >= 22.19.0（workspaces engines 要求）
 * - 依赖已安装（根 node_modules）
 * - services/brain/.env 存在（LLM/Whisper/TTS 密钥；缺失时 AI 回复会失败）
 *
 * 存储为 SQLite 单文件，由 brain 启动时自动建库建表，无需安装数据库服务。
 *
 * 用法：npm run dev:all    （等价 node scripts/dev.mjs）
 * Ctrl+C 一次即可退出并级联清理两个子进程（Windows 下用 taskkill /T 杀进程树）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ENGINE_MAJOR = 22
const BRAIN_PORT = Number(process.env.PORT || '3002')

// ---------- 前置检查 ----------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= ENGINE_MAJOR) return true
  console.warn(`[dev] ⚠ Node ${process.versions.node} < 22.19.0（workspaces engines 要求），可能无法运行`)
  return false
}

function checkDeps() {
  if (existsSync(resolve(ROOT, 'node_modules'))) return true
  console.error('[dev] ✗ 依赖未安装：请先在仓库根目录执行 npm install')
  process.exit(1)
}

function checkEnv() {
  if (existsSync(resolve(ROOT, 'services/brain/.env'))) return true
  console.warn('[dev] ⚠ services/brain/.env 不存在：LLM/Whisper/TTS 密钥未配置，AI 回复与语音会失败')
  return false
}

// ---------- 进程管理 ----------

const children = []
let shuttingDown = false

function killTree(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    // npm → node → electron 多层进程，必须杀整棵树
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[dev] 正在关闭前后端…')
  for (const child of children) killTree(child)
  // 给 taskkill 留出执行时间后退出
  setTimeout(() => process.exit(code), 600)
}

function launch(name, cwd, args) {
  // Windows 下 npm 是 .cmd，Node 无法直接 spawn（EINVAL），
  // 用 cmd.exe /c 包装（不用 shell:true，避免参数注入风险与 DEP0190 警告）
  const cmd = process.platform === 'win32' ? 'cmd.exe' : 'npm'
  const spawnArgs = process.platform === 'win32' ? ['/c', 'npm', 'run', ...args] : ['run', ...args]
  const child = spawn(cmd, spawnArgs, {
    cwd,
    stdio: 'inherit'
  })
  children.push(child)
  child.on('exit', (code) => {
    if (shuttingDown) return
    console.error(`[dev] ✗ ${name} 已退出（code ${code}），关闭另一个进程…`)
    shutdown(code ?? 1)
  })
  return child
}

// ---------- 主流程 ----------

async function main() {
  console.log('═'.repeat(60))
  console.log('  pi-amadeus 一键启动：brain 服务 + 桌面端')
  console.log('═'.repeat(60))

  checkNode()
  checkDeps()
  checkEnv()

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  console.log(`[dev] ① 启动 brain 服务（端口 ${BRAIN_PORT}，--watch 热重载）…`)
  launch('brain', resolve(ROOT, 'services/brain'), ['dev'])

  console.log('[dev] ② 启动桌面端（electron-vite dev）…')
  launch('desktop', resolve(ROOT, 'apps/desktop'), ['dev'])

  console.log('[dev] 全部启动。Ctrl+C 一键退出。')
}

main()
