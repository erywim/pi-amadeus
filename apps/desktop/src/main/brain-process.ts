import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'

const BRAIN_PORT = 3002
const HEALTH_TIMEOUT_MS = 500
const STARTUP_TIMEOUT_MS = 10_000
const SHARP_NATIVE_ROOT = join(process.resourcesPath, 'brain', 'sharp-native')

let brainProcess: ChildProcess | null = null

function healthCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const healthRequest = request(
      {
        hostname: '127.0.0.1',
        port: BRAIN_PORT,
        path: '/api/health',
        method: 'GET'
      },
      (response) => {
        response.resume()
        finish(response.statusCode === 200)
      }
    )
    healthRequest.setTimeout(HEALTH_TIMEOUT_MS, () => {
      healthRequest.destroy()
      finish(false)
    })
    healthRequest.once('error', () => finish(false))
  })
}

async function waitForBrain(): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await healthCheck()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/**
 * 打包桌面端时由主进程托管 brain；开发期仍由 scripts/dev.mjs 启动独立服务。
 * 数据目录必须落在 userData，不能把 SQLite 写进 asar 或只读 resources。
 */
export async function startBrain(): Promise<void> {
  if (!app.isPackaged) return
  if (await healthCheck()) {
    console.log('[brain] 已发现运行中的本机服务，桌面端不重复启动')
    return
  }

  const entry = join(process.resourcesPath, 'brain', 'index.mjs')
  if (!existsSync(entry)) {
    console.error(`[brain] 打包服务不存在：${entry}`)
    return
  }

  const userData = app.getPath('userData')
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(BRAIN_PORT),
      DB_PATH: join(userData, 'data', 'amadeus.db'),
      BASH_TOOL_CWD: userData,
      SHARP_NATIVE_ROOT
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  brainProcess = child
  child.stdout?.on('data', (chunk: Buffer) => console.log(`[brain] ${chunk.toString().trimEnd()}`))
  child.stderr?.on('data', (chunk: Buffer) => console.error(`[brain] ${chunk.toString().trimEnd()}`))
  child.once('error', (error) => console.error('[brain] 启动失败：', error.message))
  child.once('exit', (code, signal) => {
    if (brainProcess === child) brainProcess = null
    if (code !== 0 && signal !== 'SIGTERM') console.error(`[brain] 服务退出：code=${String(code)} signal=${String(signal)}`)
  })

  if (await waitForBrain()) {
    console.log('[brain] 打包服务已就绪')
  } else {
    console.error('[brain] 打包服务未在启动期限内就绪，转换页将显示离线状态')
  }
}

export function stopBrain(): void {
  const child = brainProcess
  brainProcess = null
  if (child && child.exitCode === null) child.kill('SIGTERM')
}
