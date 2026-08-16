/**
 * 参数级诊断：CDP 连接 headless Chrome，逐表情读取模型最终参数值。
 * 验证两件事：
 * ① 表情切换健康（expressionManager 当前条目/权重/队列长度）
 * ② 动作结束 stop() 后参数已复位到模型默认值（无动作末帧残留）
 *
 * 注意：表情的 Add 值在每帧末被 loadParameters 快照恢复，不会出现在
 * getParameterValueById 里——表情本身靠 manager 内部状态（__exprCur）验证，
 * 参数 dump 只用于验证"动作残留"。
 * 前置：node scripts/dev.mjs 已启动（vite 5173）；建议经 scripts/cdp-chrome.mjs 运行。
 */
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222'
// Emotion 枚举 = 10 个资产名（shared/emotion.ts），非法名会被 setExpression 静默忽略
const EMOTIONS = ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'shy', 'shy2', 'smile1', 'smile2', 'unhappy']
const PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamMouthOpenY', 'ParamMouthForm',
  'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLForm', 'ParamBrowRForm',
  'ParamCheek', 'ParamEyeLSmile', 'ParamEyeRSmile',
  'Param3', 'Param4', 'Param5', 'Param6', 'Param7', 'Param8',
  'Param14', 'Param15', 'Param16', 'Param17', 'ParamBreath'
]
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

const DUMP_EXPR = `(() => {
  const core = window.__live2d.core
  const out = {}
  for (const id of ${JSON.stringify(PARAMS)}) {
    out[id] = core.getParameterValueById(id)
  }
  const em = window.__live2d.model.internalModel.motionManager.expressionManager
  out.__exprQueue = em.queueManager._motions.length
  const c = em.currentExpression
  out.__exprCur = c ? (c.definition && (c.definition.Name ?? c.definition.name)) || '?' : 'none'
  out.__exprWeight = c && typeof c.weight === 'number' ? c.weight : null
  out.__motionPlaying = window.__live2d.motionLayer.isPlaying
  return out
})()`

function nonzero(v) {
  const out = {}
  for (const id of PARAMS) {
    const val = v[id]
    if (Math.abs(val) > 0.01) out[id] = Number(val.toFixed(3))
  }
  return out
}

async function main() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target')
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')

  // 干净重载（清掉已调度的待机定时器/在飞动作）
  await cdp.send('Page.navigate', { url: 'http://localhost:5173/live2d' })
  await sleep(4000)
  let ready = false
  for (let i = 0; i < 60; i++) {
    ready = await evalJs(cdp, `!!(window.__live2d && window.__live2d.model)`)
    if (ready) break
    await sleep(500)
  }
  if (!ready) throw new Error('模型未加载')

  // 确定性测试环境：静默待机手势/眨眼（保留注视游移），动作只由本脚本触发
  await evalJs(cdp, `(() => {
    window.__live2d.playGesture = () => {}
    window.__live2d.playIdleGesture = () => {}
    window.__live2d.blink = () => {}
    window.__live2d.setGazeImpulse(0, 0)
    return 'ok'
  })()`)

  // 验证 restoreParameters 的运行时通道存在（getModel → parameters.defaultValues）
  const shape = await evalJs(cdp, `(() => {
    const core = window.__live2d.model.internalModel.coreModel
    const m = core && core.getModel ? core.getModel() : null
    const p = m && m.parameters
    return {
      hasGetModel: !!core.getModel,
      hasSetParam: !!core.setParameterValueById,
      ids: p && p.ids ? p.ids.length : 0,
      defaults: p && p.defaultValues ? p.defaultValues.length : 0
    }
  })()`)
  console.log('=== restoreParameters 通道:', JSON.stringify(shape), '===\n')

  await sleep(2000)
  const base = await evalJs(cdp, DUMP_EXPR)
  console.log(`[基线 neutral] queue=${base.__exprQueue} cur=${base.__exprCur} w=${base.__exprWeight} ${JSON.stringify(nonzero(base))}`)

  console.log('\n=== 表情切换（无动作，只验证 manager 状态 + 无残留）===')
  for (const em of EMOTIONS.slice(1)) {
    await evalJs(cdp, `window.__live2d.setExpression('${em}')`)
    await sleep(1600)
    const v = await evalJs(cdp, DUMP_EXPR)
    console.log(`[${em}] queue=${v.__exprQueue} cur=${v.__exprCur} w=${v.__exprWeight} motion=${v.__motionPlaying} ${JSON.stringify(nonzero(v))}`)
  }

  // 情绪动作：中段采样（动作在跑）→ 播完 +0.3s 采样（应只剩程序层基线，无残留）
  console.log('\n=== joy 动作（4.3s，endTimer 4.25s）===')
  await evalJs(cdp, `window.__live2d.setExpression('joy')`)
  await sleep(1600)
  await evalJs(cdp, `window.__live2d.motionLayer.play('joy', 0, 3, 1)`)
  await sleep(1500)
  const joyMid = await evalJs(cdp, DUMP_EXPR)
  console.log(`[joy 动作中段] motion=${joyMid.__motionPlaying} ${JSON.stringify(nonzero(joyMid))}`)
  await sleep(3050) // 累计 4.55s > 4.25s
  const joyAfter = await evalJs(cdp, DUMP_EXPR)
  console.log(`[joy 播完 +0.3s] motion=${joyAfter.__motionPlaying} ${JSON.stringify(nonzero(joyAfter))}`)
  await sleep(1500)
  const joyLate = await evalJs(cdp, DUMP_EXPR)
  console.log(`[joy 播完 +1.8s] motion=${joyLate.__motionPlaying} ${JSON.stringify(nonzero(joyLate))}`)

  // 全身随机动作：残留最重的场景
  console.log('\n=== random1 动作（3.0s，endTimer 2.95s）===')
  await evalJs(cdp, `window.__live2d.motionLayer.play('random1', 0, 3, 1)`)
  await sleep(1200)
  const rMid = await evalJs(cdp, DUMP_EXPR)
  console.log(`[random1 中段] motion=${rMid.__motionPlaying} ${JSON.stringify(nonzero(rMid))}`)
  await sleep(2050) // 累计 3.25s > 2.95s
  const rAfter = await evalJs(cdp, DUMP_EXPR)
  console.log(`[random1 播完 +0.3s] motion=${rAfter.__motionPlaying} ${JSON.stringify(nonzero(rAfter))}`)
  await sleep(1500)
  const rLate = await evalJs(cdp, DUMP_EXPR)
  console.log(`[random1 播完 +1.8s] motion=${rLate.__motionPlaying} ${JSON.stringify(nonzero(rLate))}`)

  // 硬切场景：动作中段直接切下一个动作（play 开头会 stop+restore）
  console.log('\n=== 硬切（random2 中段 → anger 动作）===')
  await evalJs(cdp, `window.__live2d.motionLayer.play('random2', 0, 3, 1)`)
  await sleep(1200)
  await evalJs(cdp, `window.__live2d.motionLayer.play('anger', 0, 3, 1)`)
  await sleep(1500)
  const cutMid = await evalJs(cdp, DUMP_EXPR)
  console.log(`[anger 中段(硬切后)] motion=${cutMid.__motionPlaying} ${JSON.stringify(nonzero(cutMid))}`)
  await sleep(3050)
  const cutAfter = await evalJs(cdp, DUMP_EXPR)
  console.log(`[anger 播完 +0.3s] motion=${cutAfter.__motionPlaying} ${JSON.stringify(nonzero(cutAfter))}`)

  cdp.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
