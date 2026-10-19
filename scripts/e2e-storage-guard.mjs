/**
 * 持久化防损坏层 E2E：localStorage 内容损坏时不静默用默认值覆盖现场。
 *
 * 对每个使用防损坏层的 zustand persist 键，逐步回放：
 *  1. 健康数据 → 正常水合，并刷新 <key>.bak（last-good）
 *  2. 主键损坏 + 有 .bak → 从 .bak 恢复；损坏原文另存为 <key>.bad-<时间>
 *  3. 主键损坏 + 无 .bak → 状态保持水合前的值（不被默认值顶替），损坏原文同样另存
 * 测完按原始字节还原主键与 .bak、删掉本脚本产生的 .bad-*，再水合回用户原状态。
 *
 * 前置：桌面端 dev 已启动（CDP 端口默认 9222，可用 CDP_HTTP 覆盖）。
 * 用法：node scripts/e2e-storage-guard.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        call(method, params = {}) {
          return new Promise((res, rej) => {
            const callId = ++id
            pending.set(callId, { res, rej })
            ws.send(JSON.stringify({ id: callId, method, params }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${e.message ?? 'unknown'}`))
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    }
  })
}

async function evalJs(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error(`页面脚本异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result.value
}

/**
 * 在页面里对一个 persist 键回放三个场景。storeExpr 是页面内取到该 zustand store 的表达式，
 * pick 把状态投影成被持久化的那部分（也用于测后 setState 还原），sample(n) 生成一份可辨认的健康数据。
 */
async function checkKey(cdp, { key, storeExpr, pick, sample }) {
  console.log(`\n=== ${key} ===`)
  const outcome = await evalJs(
    cdp,
    `(async () => {
      const key = ${JSON.stringify(key)}
      const store = ${storeExpr}
      const pick = ${pick}
      const sample = ${sample}
      const before = { raw: localStorage.getItem(key), bak: localStorage.getItem(key + '.bak'), state: pick(store.getState()) }
      const badKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(key + '.bad-'))
      const preBad = new Set(badKeys())
      const out = {}
      try {
        const healthy = JSON.stringify({ state: sample(1), version: 0 })
        localStorage.setItem(key, healthy)
        await store.persist.rehydrate()
        out.healthyState = JSON.stringify(pick(store.getState())) === JSON.stringify(pick(sample(1)))
        out.healthyBak = localStorage.getItem(key + '.bak') === healthy

        const good = JSON.stringify({ state: sample(2), version: 0 })
        localStorage.setItem(key + '.bak', good)
        localStorage.setItem(key, '{broken-1')
        await store.persist.rehydrate()
        out.recoveredFromBak = JSON.stringify(pick(store.getState())) === JSON.stringify(pick(sample(2)))
        out.badSaved1 = badKeys().some((k) => !preBad.has(k) && localStorage.getItem(k) === '{broken-1')

        localStorage.removeItem(key + '.bak')
        localStorage.setItem(key, '{broken-2')
        await store.persist.rehydrate()
        out.keptStateWithoutBak = JSON.stringify(pick(store.getState())) === JSON.stringify(pick(sample(2)))
        out.badSaved2 = badKeys().some((k) => !preBad.has(k) && localStorage.getItem(k) === '{broken-2')
      } finally {
        // 内存状态先回到测试前（persist 会顺带写一次），再按原始字节覆盖回去（含"原本不存在"）
        store.setState(before.state)
        const put = (k, v) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v))
        put(key, before.raw)
        put(key + '.bak', before.bak)
        for (const k of badKeys()) if (!preBad.has(k)) localStorage.removeItem(k)
        out.restored =
          localStorage.getItem(key) === before.raw &&
          localStorage.getItem(key + '.bak') === before.bak &&
          JSON.stringify(pick(store.getState())) === JSON.stringify(before.state)
      }
      return out
    })()`
  )
  report('健康数据正常水合', outcome.healthyState)
  report('健康数据刷新 .bak', outcome.healthyBak)
  report('损坏 + 有 .bak → 从 .bak 恢复', outcome.recoveredFromBak)
  report('损坏原文另存 .bad-*（有 .bak 时）', outcome.badSaved1)
  report('损坏 + 无 .bak → 不被默认值顶替', outcome.keptStateWithoutBak)
  report('损坏原文另存 .bad-*（无 .bak 时）', outcome.badSaved2)
  report('测后按原始字节还原', outcome.restored)
}

let cdp = null
try {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const target = (await res.json()).find((t) => t.type === 'page' && !t.url.includes('window=pet'))
  if (!target) throw new Error(`${CDP_HTTP} 上没有主窗口页面（桌面端 dev 未启动？）`)
  cdp = await connect(target.webSocketDebuggerUrl)
  for (let i = 0; i < 50 && !(await evalJs(cdp, '!!window.__amadeus?.live2dStore').catch(() => false)); i++) await sleep(200)

  await checkKey(cdp, {
    key: 'live2d_config',
    storeExpr: 'window.__amadeus.live2dStore',
    pick: '(s) => ({ avatar: s.avatar })',
    sample: '(n) => ({ avatar: { scale: 0.3 + n / 100, positionX: n, positionY: -n } })'
  })
} catch (error) {
  report('执行', false, error instanceof Error ? error.message : String(error))
} finally {
  cdp?.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) process.exitCode = 1
