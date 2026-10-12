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

// 退出前还原：摘监听器（先摘，监听体引用 __probe）→ 还原计数钩子 → 删备份与 __probe。
// 快照缺失（没打上或已还原过）直接跳过；失败只告警不抛出——退出码语义不变
const RESTORE_EXPR = `(() => {
  const bak = window.__watchCrashBackup
  if (!bak) return 'no-patch'
  for (const [type, fn] of bak.listeners || []) window.removeEventListener(type, fn)
  for (const rec of bak.patches || []) {
    if (!rec || !rec.obj) continue
    if (rec.own) rec.obj[rec.key] = rec.fn
    else delete rec.obj[rec.key]
  }
  delete window.__watchCrashBackup
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
    if (timedOut) console.warn('[watch-crash] 补丁还原超时（CDP 已断开？），dev 实例刷新页面即可恢复')
    else if (r && r.error) console.warn('[watch-crash] 补丁还原失败（dev 实例刷新页面即可恢复）:', JSON.stringify(r.error))
  } catch (e) {
    console.warn('[watch-crash] 补丁还原失败（dev 实例刷新页面即可恢复）:', e && e.message)
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
  await cdp.send('Page.enable')

  // 挂页面内错误钩子（在重载前注入的都会丢，所以用 CDP 事件流 + reload 后重新注入）
  await cdp.send('Page.navigate', { url: 'http://localhost:5173/companion' })
  await sleep(4000)

  // 注入监控：ticker 心跳计数 + window.onerror 记录
  // 监听器引用记入 __watchCrashBackup.listeners，退出时 removeEventListener 摘除
  await evalJs(cdp, `(() => {
    window.__probe = { ticks: 0, modelUpdates: 0, errors: [] }
    const bak = window.__watchCrashBackup = window.__watchCrashBackup || {}
    bak.listeners = bak.listeners || []
    const onError = (e) => {
      window.__probe.errors.push('error: ' + (e.message || '?') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '?'))
    }
    const onRejection = (e) => {
      window.__probe.errors.push('rejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason)))
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    bak.listeners.push(['error', onError], ['unhandledrejection', onRejection])
    return 'injected'
  })()`)

  // 等模型
  for (let i = 0; i < 60; i++) {
    const r = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
    if (r.value) break
    await sleep(500)
  }

  // 挂钩：模型 internalModel.update 调用计数 + 引擎 tick 计数
  // 原实现记入 __watchCrashBackup.patches，退出时还原（不还原钩子会在 dev 实例上无限累积）
  await evalJs(cdp, `(() => {
    const bak = window.__watchCrashBackup = window.__watchCrashBackup || {}
    const model = window.__live2d.model
    const im = model.internalModel
    const engine = window.__live2d
    if (!bak.patches) {
      bak.patches = [
        { obj: im, key: 'update', own: Object.prototype.hasOwnProperty.call(im, 'update'), fn: im.update },
        { obj: engine, key: 'tick', own: Object.prototype.hasOwnProperty.call(engine, 'tick'), fn: engine.tick }
      ]
    }
    const origUpdate = im.update.bind(im)
    im.update = function (dt, now) { window.__probe.modelUpdates++; return origUpdate(dt, now) }
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

  // 正常结束：还原补丁 + 断开 CDP（幂等入口 finalize）
  await finalize()
}

main().catch((e) => {
  console.error(e)
  // 异常路径退出前同样还原页面补丁（失败只告警），退出码保持 1
  void finalize().finally(() => process.exit(1))
})
