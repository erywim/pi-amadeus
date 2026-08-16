/**
 * 表情目检工具：CDP 连接 headless Chrome，逐个切换表情/播放情绪动作
 * 并截图到 h:/project/pi-to-amadeus/.shots/。
 * 前置：node scripts/dev.mjs 已启动（vite 5173）；
 * 建议经 scripts/cdp-chrome.mjs 运行（自动起/杀 Chrome）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222'
const SHOTS_DIR = resolve(import.meta.dirname, '../../.shots')
// Emotion 枚举 = 10 个资产名（shared/emotion.ts），非法名会被 setExpression 静默忽略
const EMOTIONS = ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'shy', 'shy2', 'smile1', 'smile2', 'unhappy']
// 各情绪配套动作的节选时刻（动作 4.3s，取 1.5s 处 = 动作中段）
const MOTION_AT_MS = 1500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getPageTarget() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  return targets.find((t) => t.type === 'page')
}

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

async function evalJs(cdp, expression, awaitPromise = false) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails, null, 2))
  return res.result.value
}

async function shot(cdp, name, clip) {
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 85,
    clip,
    captureBeyondViewport: false
  })
  writeFileSync(resolve(SHOTS_DIR, `${name}.jpg`), Buffer.from(res.data, 'base64'))
  console.log(`  ✓ ${name}.jpg`)
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true })
  const target = await getPageTarget()
  if (!target) throw new Error('no page target — 先启动 npm run dev:all')
  console.log('page:', target.url)

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')

  // 干净重载（清掉已调度的待机定时器/在飞动作）
  await cdp.send('Page.navigate', { url: 'http://localhost:5173/live2d' })
  await sleep(4000)

  // 等模型加载完成
  for (let i = 0; i < 60; i++) {
    const ready = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
    if (ready) break
    await sleep(500)
  }
  const ready = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
  if (!ready) throw new Error('模型未加载')

  // 关掉登录覆盖层（若在）
  await evalJs(cdp, `(() => { const b = document.querySelector('form button[type=submit]'); if (b) b.click(); return !!b })()`)
  await sleep(800)

  // 确定性截图环境：静默待机手势/眨眼（保留注视游移），动作只由本脚本触发。
  // 同时冻结头/身游走器（min=max=0）：所有表情截图头部姿态一致，便于对比表情本身
  await evalJs(cdp, `(() => {
    window.__live2d.playGesture = () => {}
    window.__live2d.playIdleGesture = () => {}
    window.__live2d.blink = () => {}
    window.__live2d.setGazeImpulse(0, 0)
    const ws = window.__live2d.procedural.walkers
    for (const w of Object.values(ws)) { w.min = 0; w.max = 0; w.target = 0 }
    return 'ok'
  })()`)

  // 取 canvas 区域做裁剪
  const clip = await evalJs(cdp, `(() => {
    const c = window.__live2d.canvas
    const r = c.getBoundingClientRect()
    const s = 0.55
    return { x: r.x, y: r.y, width: r.width, height: r.height, scale: s }
  })()`)
  console.log('clip:', JSON.stringify(clip))

  // 引擎状态复位：光标归中、无脉冲
  await evalJs(cdp, `window.__live2d.setGazeImpulse(0, 0)`)
  await sleep(1500)

  // ① 中性 + 每个表情（只切表情，无动作）
  await evalJs(cdp, `window.__live2d.setExpression('neutral')`)
  await sleep(1500)
  await shot(cdp, 'e00-neutral', clip)
  for (const em of EMOTIONS.slice(1)) {
    await evalJs(cdp, `window.__live2d.setExpression('${em}')`)
    await sleep(1500)
    await shot(cdp, `e01-${em}`, clip)
  }

  // ② 每个表情 + 配套情绪动作（动作中段截图，模拟线上事件 600ms 防抖后播动作）
  for (const em of EMOTIONS.slice(1)) {
    await evalJs(cdp, `window.__live2d.setExpression('${em}')`)
    await sleep(700)
    const ok = await evalJs(cdp, `window.__live2d.motionLayer.play('${em}', 0, 3, 1).then(r => r)`, true)
    console.log(`  motion ${em}: started=${ok}`)
    await sleep(MOTION_AT_MS)
    await shot(cdp, `e02-${em}-motion`, clip)
    // 等动作播完 + 表情回稳
    await sleep(4500)
  }

  // ③ 动作播完后定格：表情应稳定在干净基线上（验证无动作残留）
  for (const em of ['joy', 'sadness', 'anger', 'surprise', 'shy']) {
    await evalJs(cdp, `window.__live2d.setExpression('${em}')`)
    await sleep(700)
    await evalJs(cdp, `window.__live2d.motionLayer.play('${em}', 0, 3, 1)`)
    await sleep(6500) // 动作播完 + 2s 回稳
    await shot(cdp, `e03-${em}-settled`, clip)
  }

  // ④ 中性待机（对比基线）
  await evalJs(cdp, `window.__live2d.setExpression('neutral')`)
  await sleep(2000)
  await shot(cdp, 'e04-neutral-final', clip)

  cdp.close()
  console.log('done →', SHOTS_DIR)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
