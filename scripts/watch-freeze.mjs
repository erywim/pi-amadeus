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

// 退出前还原：摘监听器（先摘，监听体引用 __probe）→ 还原计数钩子 → 删备份与 __probe。
// 快照缺失（没打上或已还原过）直接跳过；失败只告警不抛出——退出码语义不变
const RESTORE_EXPR = `(() => {
  const bak = window.__watchFreezeBackup
  if (!bak) return 'no-patch'
  for (const [type, fn] of bak.listeners || []) window.removeEventListener(type, fn)
  for (const rec of bak.patches || []) {
    if (!rec || !rec.obj) continue
    if (rec.own) rec.obj[rec.key] = rec.fn
    else delete rec.obj[rec.key]
  }
  delete window.__watchFreezeBackup
  delete window.__probe
  return 'restored'
})()`

async function restorePatches(cdp) {
  try {
    let timedOut = false
    const r = await Promise.race([
      evalJs(cdp, RESTORE_EXPR),
      sleep(3000).then(() => { timedOut = true })
    ])
    if (timedOut) console.warn('[watch-freeze] 补丁还原超时（CDP 已断开？），dev 实例刷新页面即可恢复')
    else if (r && r.error) console.warn('[watch-freeze] 补丁还原失败（dev 实例刷新页面即可恢复）:', JSON.stringify(r.error))
  } catch (e) {
    console.warn('[watch-freeze] 补丁还原失败（dev 实例刷新页面即可恢复）:', e && e.message)
  }
}

let cdp = null // 模块级：信号/异常路径也要能拿到连接做补丁还原
let finalizePromise = null

// 退出统一入口：还原页面补丁 + 断开 CDP；幂等，正常/异常/信号路径共用
function finalize() {
  if (!finalizePromise) {
    finalizePromise = (async () => {
      if (cdp) {
        await restorePatches(cdp)
        cdp.close()
      }
    })()
  }
  return finalizePromise
}

// 长驻观察期间被 Ctrl+C / kill 时也要先还原再退出（130/143 即默认信号退出码；二次信号立即强退）
function shutdown(code) {
  if (finalizePromise) process.exit(code)
  void finalize().finally(() => process.exit(code))
}
process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

async function main() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  // 重载到 live2d，干净环境
  await cdp.send('Page.navigate', { url: 'http://localhost:5173/companion' })
  await sleep(4000)
  for (let i = 0; i < 60; i++) {
    const r = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
    if (r.value) break
    await sleep(500)
  }

  // 挂钩：em.update / procedural.update / model.internalModel.update 全部计数
  // 原实现与监听器引用记入 __watchFreezeBackup，退出时还原（不还原钩子会在 dev 实例上无限累积）
  await evalJs(cdp, `(() => {
    window.__probe = { emUpdates: 0, procUpdates: 0, imUpdates: 0, lastEmNow: null, errs: [] }
    const onError = (e) => window.__probe.errs.push('error: ' + e.message)
    const onRejection = (e) => window.__probe.errs.push('rej: ' + (e.reason && e.reason.message))
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    const bak = window.__watchFreezeBackup = window.__watchFreezeBackup || {}
    bak.listeners = bak.listeners || []
    bak.listeners.push(['error', onError], ['unhandledrejection', onRejection])
    const im = window.__live2d.model.internalModel
    const em = im.motionManager.expressionManager
    const proc = window.__live2d.procedural
    if (!bak.patches) {
      bak.patches = [
        { obj: im, key: 'update', own: Object.prototype.hasOwnProperty.call(im, 'update'), fn: im.update },
        { obj: em, key: 'update', own: Object.prototype.hasOwnProperty.call(em, 'update'), fn: em.update },
        { obj: proc, key: 'update', own: Object.prototype.hasOwnProperty.call(proc, 'update'), fn: proc.update }
      ]
    }
    const origIm = im.update.bind(im)
    im.update = function (dt, now) { window.__probe.imUpdates++; return origIm(dt, now) }
    const origEm = em.update.bind(em)
    em.update = function (m, now) { window.__probe.emUpdates++; window.__probe.lastEmNow = now; return origEm(m, now) }
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
  // 正常结束：还原补丁 + 断开 CDP（幂等入口 finalize）
  await finalize()
}

main().catch((e) => {
  console.error(e)
  // 异常路径退出前同样还原页面补丁（失败只告警），退出码保持 1
  void finalize().finally(() => process.exit(1))
})
