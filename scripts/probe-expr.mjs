/**
 * 探查表达式队列内部状态：每个条目的 finished/start/end/weight/triggeredFadeOut，
 * 以及 expressionManager 每帧收到的 now 是否推进。
 */
const CDP_HTTP = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    ws.onerror = () => reject(new Error('ws error'))
  })
}

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
  return res.result.value
}

const DUMP = `(() => {
  const em = window.__live2d.model.internalModel.motionManager.expressionManager
  const q = em.queueManager
  const entries = q._motions.map((e) => ({
    finished: e._finished,
    started: e._started,
    startTime: e._startTimeSeconds.toFixed(2),
    fadeInStart: e._fadeInStartTimeSeconds.toFixed(2),
    endTime: e._endTimeSeconds.toFixed(2),
    weight: e._stateWeight.toFixed(2),
    trigFadeOut: e._isTriggeredFadeOut,
    fadeOutSec: e._fadeOutSeconds,
    params: e._motion._parameters.length
  }))
  return { count: q._motions.length, userTime: q._userTimeSeconds.toFixed(2), entries }
})()`

async function main() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  const cdp = await connect(target.webSocketDebuggerUrl)

  // 挂钩 update：记录每帧收到的 now
  await evalJs(cdp, `(() => {
    const em = window.__live2d.model.internalModel.motionManager.expressionManager
    window.__exprNowSamples = []
    const orig = em.update.bind(em)
    em.update = (m, now) => { window.__exprNowSamples.push(now); return orig(m, now) }
    return 'hooked'
  })()`)

  await evalJs(cdp, `window.__live2d.emote('joy')`)
  await sleep(3000)
  console.log('T+3s after joy:', JSON.stringify(await evalJs(cdp, DUMP), null, 2))
  console.log('now samples (last 5):', await evalJs(cdp, `window.__exprNowSamples.slice(-5).map(n => n.toFixed(3))`))

  await evalJs(cdp, `window.__live2d.emote('sadness')`)
  await sleep(3000)
  console.log('T+3s after sadness:', JSON.stringify(await evalJs(cdp, DUMP), null, 2))
  console.log('now samples (last 5):', await evalJs(cdp, `window.__exprNowSamples.slice(-5).map(n => n.toFixed(3))`))

  cdp.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
