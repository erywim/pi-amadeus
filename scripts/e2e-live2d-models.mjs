/**
 * Live2D 模型切换 E2E：在真实桌面端里逐个切换形象，验证舞台重建与模型加载。
 *
 * 覆盖的操作序列：
 *  1. 记录 live2d_config 原始字节（结束后原样还原）
 *  2. 对 kurisu / mao_pro / shizuku 逐个执行 setModelId（配置面板下拉走同一条路径）
 *  3. 每个模型断言：窗口里重新挂载的引擎拿到同一个 profile id、尺寸与脸部区域可用、
 *     眨眼/程序手势/待机表演不抛异常、live2d_config 里持久化了选择
 *  4. 打开配置面板「形象」页，断言下拉框显示当前模型的名称
 *  5. 还原 live2d_config 并刷新页面，不把调试模型留给用户
 *
 * 前置：桌面端 dev 已启动（CDP 端口默认 9222，可用 CDP_HTTP 覆盖）。
 * 用法：node scripts/e2e-live2d-models.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const MODELS = [
  { id: 'kurisu', label: '牧濑红莉栖' },
  { id: 'mao_pro', label: 'Mao Pro（Live2D 官方）' },
  { id: 'shizuku', label: 'Shizuku（Live2D 官方）' }
]

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function pageTarget() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error(`${CDP_HTTP} 上没有 page 目标（桌面端 dev 未启动？）`)
  return target
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
    ws.onclose = () => {
      for (const { rej } of pending.values()) rej(new Error('CDP 连接已关闭'))
      pending.clear()
    }
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

/** 轮询表达式；页面切换/重载期间执行上下文会短暂失效，这里吞掉这类瞬时错误继续等 */
async function waitFor(cdp, expression, timeoutMs = 45000, label = expression) {
  const start = Date.now()
  for (;;) {
    try {
      const value = await evalJs(cdp, expression)
      if (value) return value
    } catch {
      // 执行上下文还没恢复，继续等
    }
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(200)
  }
}

const target = await pageTarget()
const cdp = await connect(target.webSocketDebuggerUrl)
let originalConfig = null
let configCaptured = false

try {
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')

  // 舞台只在陪伴页，先导航过去（已经在该页时不重复导航）
  const onCompanion = await evalJs(cdp, `location.pathname.endsWith('/companion')`)
  if (!onCompanion) {
    await evalJs(cdp, `location.assign('/companion')`)
    await waitFor(cdp, `location.pathname.endsWith('/companion')`, 15000)
  }
  await waitFor(cdp, `Boolean(window.__amadeus?.live2dStore)`, 15000, '渲染层 store 就绪')

  originalConfig = await evalJs(cdp, `localStorage.getItem('live2d_config')`)
  configCaptured = true

  for (const model of MODELS) {
    await evalJs(cdp, `window.__amadeus.live2dStore.getState().setModelId(${JSON.stringify(model.id)})`)
    await waitFor(
      cdp,
      `window.__live2d?.getModelProfileId?.() === ${JSON.stringify(model.id)}`,
      45000,
      `${model.id} 引擎就绪`
    )

    const state = await evalJs(
      cdp,
      `(() => {
        const E = window.__live2d
        const size = E.getModelSize()
        const face = E.faceRect()
        E.blink(1)
        const gestured = E.gesture('nod')
        E.playIdlePerformance()
        return {
          size,
          face,
          gestured,
          persisted: JSON.parse(localStorage.getItem('live2d_config') || '{}').state?.modelId
        }
      })()`
    )
    report(`${model.id} 加载并渲染`, Boolean(state.size?.width > 0 && state.size?.height > 0), JSON.stringify(state.size))
    report(`${model.id} 脸部区域可用`, Boolean(state.face?.width > 0 && state.face?.height > 0))
    report(`${model.id} 手势可用`, state.gestured === true)
    report(`${model.id} 选择已持久化`, state.persisted === model.id, `got ${state.persisted}`)

    // 配置面板走同一条 store 路径；这里额外断言下拉框显示当前模型名
    await evalJs(cdp, `window.__amadeus.uiStore.getState().setConfigPanelOpen(true, 'avatar')`)
    await waitFor(
      cdp,
      `document.querySelector('[role="combobox"]')?.textContent?.includes(${JSON.stringify(model.label)}) === true`,
      10000,
      `配置面板显示 ${model.label}`
    )
    report(`${model.id} 配置面板显示正确名称`, true)
    await evalJs(cdp, `window.__amadeus.uiStore.getState().setConfigPanelOpen(false)`)
  }
} catch (error) {
  report('执行过程', false, error instanceof Error ? error.message : String(error))
} finally {
  // 还原用户原来的选择；live2d_config 可能原本不存在。
  // 只有确实读到过原始值才动它——连接失败时不能把用户的配置删掉。
  if (configCaptured) {
    await evalJs(
      cdp,
      originalConfig === null
        ? `localStorage.removeItem('live2d_config')`
        : `localStorage.setItem('live2d_config', ${JSON.stringify(originalConfig)})`
    ).catch(() => {})
    await cdp.call('Page.reload', {}).catch(() => {})
  }
  cdp.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 1)
