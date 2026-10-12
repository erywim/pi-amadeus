/**
 * 精确采样：动作停止前后，每个参数值与 moc3 默认值的偏差。
 * 页面内 setTimeout 采样（CDP 往返有抖动，采样必须在渲染进程内计时）。
 * 预期：stop 后 +0.1s 偏差清空（restoreParameters 生效），随后程序层
 * 平滑重播种（头部跟随/游移）逐步接管——偏差重新出现但性质不同（平滑小步）。
 * 前置：经 scripts/cdp-chrome.mjs 运行。
 */
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222'
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

// 退出前还原本脚本自打的补丁（下面 SAMPLE_EXPR 里静默掉的 blink/手势）。
// 注意区别于本脚本要验证的 restoreParameters（引擎层参数复位，被测对象，不动它）。
// 快照缺失（补丁没打上或已还原过）直接跳过；失败只告警不抛出——退出码语义不变
const RESTORE_EXPR = `(() => {
  const bak = window.__probeRestoreBackup
  if (!bak) return 'no-patch'
  for (const rec of bak.patches || []) {
    if (!rec || !rec.obj) continue
    if (rec.own) rec.obj[rec.key] = rec.fn
    else delete rec.obj[rec.key]
  }
  delete window.__probeRestoreBackup
  return 'restored'
})()`

async function restorePatches(cdp) {
  try {
    let timedOut = false
    await Promise.race([
      evalJs(cdp, RESTORE_EXPR),
      sleep(3000).then(() => { timedOut = true })
    ])
    if (timedOut) console.warn('[probe-restore] 补丁还原超时（CDP 已断开？），dev 实例刷新页面即可恢复')
  } catch (e) {
    console.warn('[probe-restore] 补丁还原失败（dev 实例刷新页面即可恢复）:', e && e.message)
  }
}

const SAMPLE_EXPR = `(async () => {
  const engine = window.__live2d
  const core = engine.core
  const params = engine.model.internalModel.coreModel.getModel().parameters
  const ids = params.ids
  const defaults = params.defaultValues
  const out = []
  const snap = (label) => {
    const diffs = {}
    for (let i = 0; i < ids.length; i++) {
      const v = core.getParameterValueById(ids[i])
      const d = defaults[i]
      if (Math.abs(v - d) > 0.01) diffs[ids[i]] = { v: +v.toFixed(3), d: +d.toFixed(3) }
    }
    out.push({ label, diffs })
  }
  // 静默手势/眨眼保证采样确定性（本脚本自打的补丁）；原实现入 __probeRestoreBackup，
  // 脚本结束后由 restorePatches 还原——与被测的 restoreParameters 无关
  const bak = window.__probeRestoreBackup = window.__probeRestoreBackup || {}
  if (!bak.patches) {
    bak.patches = ['playTalkingGesture', 'playIdleGesture', 'blink'].map((key) => ({
      obj: engine,
      key,
      own: Object.prototype.hasOwnProperty.call(engine, key),
      fn: engine[key]
    }))
  }
  engine.playTalkingGesture = () => {}
  engine.playIdleGesture = () => {}
  engine.blink = () => {}
  engine.setGazeImpulse(0, 0)
  await new Promise((r) => setTimeout(r, 1500))
  snap('基线(无动作, 程序层稳定)')
  engine.motionLayer.play('random2', 0, 3, 1)
  const waits = [
    [2800, '动作末段(pre-stop)'],
    [200, 'stop后+0.1s'],
    [400, 'stop后+0.5s'],
    [1400, 'stop后+1.9s']
  ]
  for (const [ms, label] of waits) {
    await new Promise((r) => setTimeout(r, ms))
    snap(label)
  }
  return out
})()`

// cdp 提升到模块级：异常路径也要能拿到连接做补丁还原
let cdp = null

async function main() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target')
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url: 'http://localhost:5173/companion' })
  await sleep(4000)
  let ready = false
  for (let i = 0; i < 60; i++) {
    ready = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
    if (ready) break
    await sleep(500)
  }
  if (!ready) throw new Error('模型未加载')

  // 顺带确认表情 manager 当前条目字段结构（供诊断脚本使用）
  const exprShape = await evalJs(cdp, `(() => {
    const c = window.__live2d.model.internalModel.motionManager.expressionManager.currentExpression
    if (!c) return 'no current'
    return {
      ownKeys: Object.keys(c),
      defKeys: c.definition ? Object.keys(c.definition) : null,
      defName: c.definition ? (c.definition.Name !== undefined ? c.definition.Name : (c.definition.name !== undefined ? c.definition.name : '?')) : '?'
    }
  })()`)
  console.log('=== expressionManager.currentExpression 结构:', JSON.stringify(exprShape), '===\n')

  const samples = await evalJs(cdp, SAMPLE_EXPR)
  for (const s of samples) {
    const n = Object.keys(s.diffs).length
    console.log(`[${s.label}] 偏差参数 ${n} 个`)
    for (const [id, dv] of Object.entries(s.diffs)) {
      console.log(`    ${id}: v=${dv.v} d=${dv.d} Δ=${(dv.v - dv.d).toFixed(3)}`)
    }
  }
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
