/**
 * 重放「切表情 + 播动作」完整序列，逐步骤采样，
 * 找到 expressionManager.update 停止被调用的那一刻。
 * 钩子注意：PIXI Ticker 持有注册时的函数引用，必须钩被调用对象的属性
 * （procedural.update 每帧做属性查找，可安全包装）。
 */
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222'
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

  // 重载到 live2d，干净环境
  await cdp.send('Page.navigate', { url: 'http://localhost:5173/live2d' })
  await sleep(4000)
  for (let i = 0; i < 60; i++) {
    const r = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
    if (r.value) break
    await sleep(500)
  }

  // 挂钩：em.update / procedural.update / model.internalModel.update 全部计数
  await evalJs(cdp, `(() => {
    window.__probe = { emUpdates: 0, procUpdates: 0, imUpdates: 0, lastEmNow: null, errs: [] }
    window.addEventListener('error', (e) => window.__probe.errs.push('error: ' + e.message))
    window.addEventListener('unhandledrejection', (e) => window.__probe.errs.push('rej: ' + (e.reason && e.reason.message)))
    const im = window.__live2d.model.internalModel
    const origIm = im.update.bind(im)
    im.update = function (dt, now) { window.__probe.imUpdates++; return origIm(dt, now) }
    const em = im.motionManager.expressionManager
    const origEm = em.update.bind(em)
    em.update = function (m, now) { window.__probe.emUpdates++; window.__probe.lastEmNow = now; return origEm(m, now) }
    const proc = window.__live2d.procedural
    const origProc = proc.update.bind(proc)
    proc.update = function (input, core, owned) { window.__probe.procUpdates++; return origProc(input, core, owned) }
    return 'hooked'
  })()`)

  const snapshot = async (label) => {
    const r = await evalJs(
      cdp,
      `JSON.stringify({ im: window.__probe.imUpdates, em: window.__probe.emUpdates, proc: window.__probe.procUpdates, lastEmNow: window.__probe.lastEmNow && window.__probe.lastEmNow.toFixed(2), errs: window.__probe.errs })`
    )
    console.log(label, r.value)
  }

  await sleep(1500)
  await snapshot('基线:')

  const EMOS = ['joy', 'sadness', 'anger', 'surprise', 'shy', 'joy', 'sadness', 'anger']
  for (const em of EMOS) {
    await evalJs(cdp, `window.__live2d.emote('${em}')`)
    await sleep(700)
    await evalJs(cdp, `window.__live2d.motionLayer.play('${em}', 0, 3, 1)`)
    await sleep(1200)
    await snapshot(`${em} 动作中:`)
    await sleep(4000) // 等动作播完
    await snapshot(`${em} 动作后:`)
  }

  const excEvents = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
  console.log('\nCDP exceptionThrown:', excEvents.length)
  for (const e of excEvents.slice(0, 3)) {
    console.log(' -', e.params.exceptionDetails?.text, '|', e.params.exceptionDetails?.exception?.description?.split('\n').slice(0, 5).join(' ⏎ '))
  }
  cdp.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
