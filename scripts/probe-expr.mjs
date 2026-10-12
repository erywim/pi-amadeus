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

// 退出前还原 update 钩子：快照在则回写/删除复原，快照缺失直接跳过。
// 失败只告警不抛出——探针退出码语义不变
const RESTORE_EXPR = `(() => {
  const bak = window.__probeExprBackup
  if (!bak) return 'no-patch'
  for (const rec of bak.patches || []) {
    if (!rec || !rec.obj) continue
    if (rec.own) rec.obj[rec.key] = rec.fn
    else delete rec.obj[rec.key]
  }
  delete window.__probeExprBackup
  delete window.__exprNowSamples
  return 'restored'
})()`

async function restorePatches(cdp) {
  try {
    let timedOut = false
    await Promise.race([
      evalJs(cdp, RESTORE_EXPR),
      sleep(3000).then(() => { timedOut = true })
    ])
    if (timedOut) console.warn('[probe-expr] 补丁还原超时（CDP 已断开？），dev 实例刷新页面即可恢复')
  } catch (e) {
    console.warn('[probe-expr] 补丁还原失败（dev 实例刷新页面即可恢复）:', e && e.message)
  }
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

// cdp 提升到模块级：异常路径也要能拿到连接做补丁还原
let cdp = null

async function main() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  cdp = await connect(target.webSocketDebuggerUrl)

  // 挂钩 update：记录每帧收到的 now。原实现先快照进 __probeExprBackup，
  // 退出时由 restorePatches 还原（本脚本不重载页面，不还原则 dev 实例计数钩子永久累积）
  await evalJs(cdp, `(() => {
    const em = window.__live2d.model.internalModel.motionManager.expressionManager
    window.__exprNowSamples = []
    const bak = window.__probeExprBackup = window.__probeExprBackup || {}
    if (!bak.patches) {
      bak.patches = [{ obj: em, key: 'update', own: Object.prototype.hasOwnProperty.call(em, 'update'), fn: em.update }]
    }
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

  // 正常结束：还原补丁后再断连
  await restorePatches(cdp)
  cdp.close()
  cdp = null
}

main().catch((e) => {
  console.error(e)
  // 异常路径退出前同样还原页面补丁（失败只告警），退出码保持 1
  const p = cdp ? restorePatches(cdp) : Promise.resolve()
  p.finally(() => process.exit(1))
})
