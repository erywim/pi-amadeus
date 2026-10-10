/**
 * Live2D 目检截图工具（跨平台，替代仅限 Windows 的 cdp-chrome.mjs + shot-expressions.mjs 组合）。
 *
 * 每次运行起一个独立的 headless Chrome（独立 user-data-dir、端口由 Chrome 自选，
 * 多个实例可并行），打开渲染层页面，等模型加载后按"计划"逐条执行 JS 并截图，
 * 最后可选生成一张拼图（contact sheet）便于一次对比多张。
 *
 * 前置：渲染层 dev server 已启动（任选其一）
 *   - npm run dev                         （electron-vite dev，含 Electron）
 *   - cd apps/desktop && npx electron-vite dev --rendererOnly   （仅渲染层，无需 Electron）
 *
 * 用法：
 *   node scripts/live2d-shot.mjs --plan plan.json [--out dir] [--sheet name] [--url URL]
 *   node scripts/live2d-shot.mjs --plan-json '{"shots":[{"name":"neutral"}]}'
 *
 * 计划格式：
 *   {
 *     "freeze": true,          // 冻结待机随机性（手势/眨眼/游走/注视），默认 true
 *     "showUi": false,         // 保留界面元素（默认只留 Live2D 画布，便于看表情）
 *     "setup": "js 表达式",     // 模型就绪后执行一次（可返回 Promise）
 *     "clip": "head",          // 默认裁剪：canvas | head | face | {x,y,width,height}
 *     "shots": [{ "name": "a", "js": "...", "waitMs": 1200, "clip": "face" }]
 *   }
 * 页面里 `E` 即 window.__live2d（引擎调试钩子）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i++
    }
  }
  return args
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ]
      : process.platform === 'win32'
        ? [
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('未找到 Chrome，可用 CHROME_PATH 环境变量指定')
  return found
}

/** 起 headless Chrome：端口由 Chrome 自选（--remote-debugging-port=0），从 DevToolsActivePort 读回 */
async function launchChrome({ width, height, dpr }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'amadeus-shot-'))
  const flags = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dpr}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    '--no-first-run',
    '--hide-scrollbars',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    // file:// 拼图页需要读同目录图片
    '--allow-file-access-from-files',
    'about:blank'
  ]
  const chrome = spawn(findChrome(), flags, {
    stdio: 'ignore',
    windowsHide: true,
    // POSIX：独立进程组，结束时整组杀掉（含 GPU/渲染子进程）
    detached: process.platform !== 'win32'
  })
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split('\n')[0]?.trim()
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`)
          if (res.ok) return { chrome, port, profileDir }
        } catch {
          // 端口文件已写但 HTTP 未就绪，继续等
        }
      }
    }
    await sleep(200)
  }
  killChrome(chrome)
  throw new Error('Chrome 未在超时内就绪')
}

function killChrome(chrome) {
  if (!chrome?.pid || chrome.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(chrome.pid)], { stdio: 'ignore' })
    } else {
      process.kill(-chrome.pid, 'SIGKILL')
    }
  } catch {
    // 进程已退出
  }
}

/** 页面报错收集（未捕获异常 + console.error），运行结束时打印 */
const pageErrors = []

function connect(url) {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    ws.onopen = () =>
      resolveP({
        send(method, params = {}) {
          return new Promise((res2, rej2) => {
            const id = nextId++
            pending.set(id, { res2, rej2 })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        close: () => ws.close()
      })
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        pageErrors.push(d.exception?.description ?? d.text)
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej2(new Error(msg.error.message))
        else res2(msg.result)
      }
    }
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`))
  })
}

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) {
    const d = res.exceptionDetails
    throw new Error(`页面脚本异常: ${d.exception?.description ?? d.text}`)
  }
  return res.result.value
}

/** 包装用户 JS：E = 引擎钩子；支持语句块与 await */
const wrap = (js) => `(async () => { const E = window.__live2d; ${js}\n })()`

// 截图前准备：只留 Live2D 画布（隐藏覆盖层 UI），中灰背景便于看清颜色
const HIDE_UI_JS = `(() => {
  const c = window.__live2d.canvas
  c.setAttribute('data-shot-canvas', '1')
  const style = document.createElement('style')
  style.textContent = 'html,body{background:#3a3a3e !important} body *{visibility:hidden !important} [data-shot-canvas]{visibility:visible !important}'
  document.head.appendChild(style)
  return 'ok'
})()`

// 冻结待机随机性：待机调度（随机手势/眨眼/注视游移）、头身游走、库自带呼吸摆动全部静止，截图可对比。
// 只拦调度入口，情绪/动作接口（E.emote / E.gesture / E.previewRecipe）照常可用
const FREEZE_JS = `(() => {
  const E = window.__live2d
  E.playTalkingGesture = () => {}
  E.playIdleGesture = () => {}
  E.blink = () => {}
  E.setGazeImpulse(0, 0)
  E.setGazeImpulse = () => {}
  if (E.debugFreeze) E.debugFreeze(true)
  return 'ok'
})()`

/** 裁剪区域（CSS 像素）：canvas 全幅 / head 头部 / face 面部（按模型包围盒比例估算，引擎提供锚点时优先用锚点） */
const CLIP_JS = (kind) => `(() => {
  const E = window.__live2d
  const r = E.canvas.getBoundingClientRect()
  const kind = ${JSON.stringify(kind)}
  if (kind === 'canvas') return { x: r.x, y: r.y, width: r.width, height: r.height }
  if (E.debugRegion) {
    const reg = E.debugRegion(kind)
    if (reg) return reg
  }
  const b = E.model.getBounds()
  const cx = b.x + b.width / 2
  if (kind === 'face') return { x: cx - b.width * 0.2, y: b.y + b.height * 0.08, width: b.width * 0.4, height: b.height * 0.22 }
  return { x: cx - b.width * 0.32, y: b.y, width: b.width * 0.64, height: b.height * 0.42 }
})()`

async function capture(cdp, file, rect, scale) {
  const clip = {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    scale
  }
  const res = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88, clip })
  writeFileSync(file, Buffer.from(res.data, 'base64'))
}

/** 拼图：本地 HTML 网格 + 整页截图 */
async function makeSheet(cdp, outDir, sheetName, items, cols) {
  const cells = items
    .map(
      (it) => `<figure><img src="${pathToFileURL(it.file).href}"><figcaption>${it.name}</figcaption></figure>`
    )
    .join('')
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#202024;font:14px/1.3 -apple-system,'PingFang SC',sans-serif;color:#eee}
    main{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px}
    figure{margin:0;background:#2c2c30} img{width:100%;display:block}
    figcaption{padding:3px 6px;font-size:13px}
  </style><main>${cells}</main>`
  const htmlFile = join(outDir, `${sheetName}.html`)
  writeFileSync(htmlFile, html)
  await cdp.send('Page.navigate', { url: pathToFileURL(htmlFile).href })
  await sleep(800)
  // 按网格实际内容裁剪（整页高度至少是视口高，少图时会留大片空白）
  const size = await evalJs(
    cdp,
    `(() => { const r = document.querySelector('main').getBoundingClientRect(); return { w: Math.ceil(r.right), h: Math.ceil(r.bottom) } })()`
  )
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 85,
    clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 },
    captureBeyondViewport: true
  })
  const file = join(outDir, `${sheetName}.jpg`)
  writeFileSync(file, Buffer.from(res.data, 'base64'))
  return file
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const plan = args['plan-json']
    ? JSON.parse(args['plan-json'])
    : args.plan
      ? JSON.parse(readFileSync(resolve(args.plan), 'utf8'))
      : null
  if (!plan?.shots?.length) {
    console.error('用法: node scripts/live2d-shot.mjs --plan plan.json | --plan-json <json> [--out dir] [--sheet name]')
    process.exit(2)
  }
  const url = args.url || 'http://localhost:5173/live2d'
  const outDir = resolve(args.out || join(tmpdir(), 'amadeus-shots'))
  mkdirSync(outDir, { recursive: true })
  const width = Number(args.width || 1280)
  const height = Number(args.height || 800)
  const dpr = Number(args.dpr || 2)
  const scale = Number(args.scale || 1)

  const { chrome, port, profileDir } = await launchChrome({ width, height, dpr })
  let code = 0
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有 page target')
    const cdp = await connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url })

    let ready = false
    for (let i = 0; i < 120 && !ready; i++) {
      await sleep(500)
      ready = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`).catch(() => false)
    }
    if (!ready) throw new Error(`模型未在超时内加载：${url}`)
    await sleep(600)
    if (!plan.showUi) await evalJs(cdp, HIDE_UI_JS)
    if (plan.freeze !== false) await evalJs(cdp, FREEZE_JS)
    if (plan.setup) await evalJs(cdp, wrap(plan.setup))
    await sleep(Number(plan.settleMs ?? 1200))

    const saved = []
    for (const shot of plan.shots) {
      let note = ''
      if (shot.js) {
        const v = await evalJs(cdp, wrap(shot.js))
        if (v !== undefined) note = typeof v === 'string' ? v : JSON.stringify(v)
      }
      await sleep(Number(shot.waitMs ?? plan.waitMs ?? 1500))
      const clipKind = shot.clip ?? plan.clip ?? 'head'
      const rect = typeof clipKind === 'object' ? clipKind : await evalJs(cdp, CLIP_JS(clipKind))
      const file = join(outDir, `${shot.name}.jpg`)
      await capture(cdp, file, rect, scale)
      saved.push({ name: shot.label ?? shot.name, file })
      console.log(`✓ ${file}${note ? `  ← ${note}` : ''}`)
    }

    if (args.sheet) {
      const cols = Number(args.cols || Math.min(4, saved.length))
      const sheet = await makeSheet(cdp, outDir, String(args.sheet), saved, cols)
      console.log(`▣ ${sheet}`)
    }
    if (pageErrors.length) {
      console.log(`⚠ 页面报错 ${pageErrors.length} 条：`)
      for (const err of pageErrors.slice(0, 10)) console.log(`  - ${String(err).split('\n')[0]}`)
    } else {
      console.log('✓ 页面无报错')
    }
    cdp.close()
  } catch (e) {
    console.error('[live2d-shot]', e.message)
    code = 1
  } finally {
    killChrome(chrome)
    await sleep(300)
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // Chrome 仍持有文件时留给系统清理
    }
  }
  process.exit(code)
}

main()
