/**
 * Headless Chrome 测试包装：每次测试起全新 Chrome 实例（GCM 后台注册
 * 约 2 分钟后会拖死进程，不能长驻），等 CDP 端口就绪后跑子脚本，
 * 子脚本通过 CDP_HTTP 环境变量连接。结束后杀干净进程树。
 *
 * 用法：node scripts/cdp-chrome.mjs scripts/dump-params.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = process.env.CDP_PORT || '9223'
const TEST_URL = 'http://localhost:5173/companion'
const testArgs = process.argv.slice(2)
if (!testArgs.length) {
  console.error('用法: node scripts/cdp-chrome.mjs <测试脚本.mjs> [args...]')
  process.exit(1)
}

// 每次运行独立 user-data-dir：避免上一实例残留锁/单例复用导致静默失败
const profileDir = mkdtempSync(join(tmpdir(), 'chrome-pi-amadeus-'))

const flags = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1280,800',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-networking', // 关掉 GCM/推送等后台网络（headless 下会拖死进程）
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-extensions',
  '--no-first-run',
  '--hide-scrollbars',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  TEST_URL
]

const chrome = spawn(CHROME, flags, { stdio: 'ignore', windowsHide: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return
    } catch {
      // 端口未就绪，继续等
    }
    await sleep(300)
  }
  throw new Error('chrome 未在超时内就绪')
}

function killTree(pid) {
  if (!pid) return null
  // windowsHide 的 chrome.exe 树要 taskkill /T 清杀
  const k = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  k.on('error', () => {})
  return k
}

let childCode = 1
try {
  await waitReady()
  console.log(`[cdp-chrome] 就绪 http://127.0.0.1:${PORT}`)
  childCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, testArgs, {
      stdio: 'inherit',
      env: { ...process.env, CDP_HTTP: `http://127.0.0.1:${PORT}` }
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
  console.log(`[cdp-chrome] 子脚本退出码 ${childCode}`)
} catch (e) {
  console.error('[cdp-chrome]', e.message)
} finally {
  // 等 taskkill 完成再退出，避免进程树残留
  await new Promise((resolve) => {
    const k = killTree(chrome.pid)
    if (!k) return resolve()
    k.on('exit', resolve)
  })
  process.exit(childCode ?? 1)
}
