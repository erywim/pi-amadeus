/**
 * 抓渲染循环死亡现场：重载 live2d 页 → 挂 error/exception/console 监听 →
 * 复现「切表情 + 播动作」序列 → 观察 ticker 是否存活、异常栈是谁抛的。
 */
const CDP_HTTP = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(url) {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    const events = []
    const state = {
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const id = nextId++
          pending.set(id, { res2, rej2 })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      events,
      close: () => ws.close()
    }
    ws.onopen = () => resolveP(state)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej2(new Error(msg.error.message))
        else res2(msg.result)
      } else if (msg.method) {
        events.push(msg)
      }
    }
    ws.onerror = () => reject(new Error('ws error'))
  })
}

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) return { error: res.exceptionDetails }
  return { value: res.result.value }
}

async function main() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 挂页面内错误钩子（在重载前注入的都会丢，所以用 CDP 事件流 + reload 后重新注入）
  await cdp.send('Page.navigate', { url: 'http://localhost:5173/companion' })
  await sleep(4000)

  // 注入监控：ticker 心跳计数 + window.onerror 记录
  await evalJs(cdp, `(() => {
    window.__probe = { ticks: 0, modelUpdates: 0, errors: [] }
    window.addEventListener('error', (e) => {
      window.__probe.errors.push('error: ' + (e.message || '?') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '?'))
    })
    window.addEventListener('unhandledrejection', (e) => {
      window.__probe.errors.push('rejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason)))
    })
    return 'injected'
  })()`)

  // 等模型
  for (let i = 0; i < 60; i++) {
    const r = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
    if (r.value) break
    await sleep(500)
  }

  // 挂钩：模型 internalModel.update 调用计数 + 引擎 tick 计数
  await evalJs(cdp, `(() => {
    const model = window.__live2d.model
    const im = model.internalModel
    const origUpdate = im.update.bind(im)
    im.update = function (dt, now) { window.__probe.modelUpdates++; return origUpdate(dt, now) }
    const engine = window.__live2d
    const origTick = engine.tick.bind(engine)
    engine.tick = function (d) { window.__probe.ticks++; return origTick(d) }
    return 'hooked'
  })()`)

  // 基线：等 2s 看心跳
  await sleep(2000)
  let probe = await evalJs(cdp, `JSON.stringify(window.__probe)`)
  console.log('基线(2s):', probe.value)

  // 复现序列：切表情 + 播动作
  await evalJs(cdp, `window.__live2d.emote('joy')`)
  await sleep(800)
  await evalJs(cdp, `window.__live2d.motionLayer.play('joy', 0, 3, 1)`)
  await sleep(2000)
  probe = await evalJs(cdp, `JSON.stringify(window.__probe)`)
  console.log('动作中(2s):', probe.value)

  await sleep(4000)
  probe = await evalJs(cdp, `JSON.stringify(window.__probe)`)
  console.log('动作后(4s):', probe.value)

  // 切表情到 sadness 再观察
  await evalJs(cdp, `window.__live2d.emote('sadness')`)
  await sleep(2000)
  probe = await evalJs(cdp, `JSON.stringify(window.__probe)`)
  console.log('sadness后(2s):', probe.value)

  // CDP 层捕获的异常
  const excEvents = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
  console.log('\nCDP exceptionThrown:', excEvents.length)
  for (const e of excEvents) {
    const d = e.params.exceptionDetails
    console.log(' -', d.text, '|', d.exception?.description?.split('\n').slice(0, 4).join(' ⏎ '))
  }
  const consoleErrors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  console.log('console.error:', consoleErrors.length)
  for (const e of consoleErrors.slice(0, 5)) {
    console.log(' -', JSON.stringify(e.params.args?.map((a) => a.value ?? a.description).slice(0, 2)))
  }

  cdp.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
