/**
 * 陪伴舞台摆位 E2E（CDP 驱动真实桌面端 dev；不依赖 brain）。
 *
 * 覆盖的操作序列：
 *  1. 进入陪伴页，切到 kurisu（尺寸固定，断言可复现）
 *  2. 在角色可见网格上按住拖动 → 角色跟随指针；松手不触发戳一戳；摆位写进 live2d_config
 *  3. 往舞台右下角猛拖 → 模型画布至少三成留在舞台内（拖不出视野）；左上角同理
 *  4. 滚轮缩放 → 比例变化并持久化；极端滚轮被夹在舞台高度的 20%~120%
 *  5. 刷新页面 → 摆位从 live2d_config 恢复（记忆）
 *
 * 前置：桌面端 dev 已启动（CDP 端口默认 9222，可用 CDP_HTTP 覆盖）。
 * 测完按原始字节还原 live2d_config（含原本不存在的情况）并刷新，不把测试摆位留给用户。
 * 用法：node scripts/e2e-companion-place.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
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

/** 轮询表达式；页面重载期间执行上下文会短暂失效，吞掉这类瞬时错误继续等 */
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

const waitEngine = (cdp, modelId) =>
  waitFor(
    cdp,
    `window.__live2d?.getModelProfileId?.() === ${JSON.stringify(modelId)}`,
    45000,
    `${modelId} 引擎就绪`
  )

/**
 * 关闭登录覆盖层：它会挡住舞台上的鼠标事件（拖拽不依赖登录身份，uiStore 不持久化）。
 * 等到遮罩真的从 DOM 消失再返回——只改 store 时 React 可能还没提交卸载。
 */
const dismissLogin = (cdp) =>
  waitFor(
    cdp,
    `(() => {
      const store = window.__amadeus?.uiStore
      if (!store) return false
      store.getState().closeLogin()
      return !document.querySelector('[class*="bg-black/85"]')
    })()`,
    20000,
    '关闭登录覆盖层'
  )

const avatarExpr = (modelId) =>
  `window.__amadeus.live2dStore.getState().avatars[${JSON.stringify(modelId)}]`

/** 当前摆位（store） */
const avatar = (cdp, modelId) => evalJs(cdp, avatarExpr(modelId))

/** 舞台几何 + 脸上一个确实命中网格的视口坐标（容器坐标 + 页面偏移） */
const hitPoint = (cdp) =>
  evalJs(
    cdp,
    `(() => {
      const stage = document.querySelector('.stage-pattern')
      const E = window.__live2d
      if (!stage || !E) return null
      const r = stage.getBoundingClientRect()
      const f = E.debugRegion('face')
      if (!f) return null
      // 从脸部中心向外找：越靠中心的点越不容易被待机微动挪出网格
      const pts = []
      for (let gy = 0.2; gy <= 0.8; gy += 0.1) {
        for (let gx = 0.2; gx <= 0.8; gx += 0.1) pts.push({ gx, gy, d: Math.hypot(gx - 0.5, gy - 0.5) })
      }
      pts.sort((a, b) => a.d - b.d)
      for (const { gx, gy } of pts) {
        const localX = f.x + f.width * gx
        const localY = f.y + f.height * gy
        if (E.hitTest(localX, localY)) {
          return { x: localX + r.left, y: localY + r.top, stage: { left: r.left, top: r.top, width: r.width, height: r.height } }
        }
      }
      return null
    })()`
  )

const mouse = (cdp, type, x, y, extra = {}) =>
  cdp.call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    ...extra
  })

const wheel = (cdp, x, y, deltaY) =>
  cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })

const target = await pageTarget()
const cdp = await connect(target.webSocketDebuggerUrl)
let originalConfig = null
let originalBak = null
let configCaptured = false

try {
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')

  // 舞台只在陪伴页
  const onCompanion = await evalJs(cdp, `location.pathname.endsWith('/companion')`)
  if (!onCompanion) {
    await evalJs(cdp, `location.assign('/companion')`)
    await waitFor(cdp, `location.pathname.endsWith('/companion')`, 15000, '进入陪伴页')
  }
  await waitFor(cdp, `Boolean(window.__amadeus?.live2dStore)`, 15000, '渲染层 store 就绪')
  // 页面被隐藏/完全遮挡时 Chromium 会把 visibilityState 置为 hidden，
  // 并丢弃 mousePressed（pointermove 仍会到）——拖拽断言会全部失效，先明确失败
  if (!(await evalJs(cdp, `document.visibilityState === 'visible'`))) {
    throw new Error('桌面端窗口不可见（被隐藏或被完全遮挡）：请切到前台后重跑 E2E')
  }
  // 登录覆盖层（z-40）会挡住舞台上的鼠标事件；它本来就是"输入用户名后关闭"的遮罩，
  // 这里只走它的关闭路径（拖拽不依赖登录身份）；uiStore 不持久化，刷新后回到默认。
  // 用 waitFor 重试：页面重载期间 __amadeus 会短暂缺席
  await dismissLogin(cdp)

  originalConfig = await evalJs(cdp, `localStorage.getItem('live2d_config')`)
  originalBak = await evalJs(cdp, `localStorage.getItem('live2d_config.bak')`)
  configCaptured = true

  // 红莉栖模型尺寸固定，摆位断言可复现（结束后整体还原）
  await evalJs(cdp, `window.__amadeus.live2dStore.getState().setModelId('kurisu')`)
  await waitEngine(cdp, 'kurisu')

  // 起点归中，避免用户原来的摆位影响边界断言
  await evalJs(cdp, `window.__amadeus.live2dStore.getState().setAvatar({ positionX: 0, positionY: 0 })`)
  await sleep(100)

  // —— 1. 拖动：角色跟随指针，摆位持久化，松手不误触戳一戳 ——
  await evalJs(
    cdp,
    `(() => {
      const E = window.__live2d
      window.__probe = { pokes: 0, original: E.perform, idle: E.playIdlePerformance }
      E.perform = function (...args) { window.__probe.pokes += 1; return window.__probe.original.apply(this, args) }
      // 待机小表演也会走 perform：测拖动误触期间只留戳一戳这一条路径
      E.playIdlePerformance = () => {}
      return true
    })()`
  )
  const p0 = await avatar(cdp, 'kurisu')
  const hit = await hitPoint(cdp)
  if (!hit) throw new Error('找不到角色可见网格上的命中点')
  const DX = 150
  const DY = -50
  await mouse(cdp, 'mousePressed', hit.x, hit.y)
  for (let i = 1; i <= 10; i++) {
    await mouse(cdp, 'mouseMoved', hit.x + (DX * i) / 10, hit.y + (DY * i) / 10)
  }
  await mouse(cdp, 'mouseReleased', hit.x + DX, hit.y + DY)
  const p1 = await waitFor(
    cdp,
    `(() => { const a = ${avatarExpr('kurisu')}; return a.positionX === ${p0.positionX + DX} ? a : null })()`,
    3000,
    '拖动后位置更新'
  ).catch(() => null)
  report(
    '拖动后角色跟随指针',
    !!p1 && p1.positionX === p0.positionX + DX && p1.positionY === p0.positionY + DY,
    `x=${p1?.positionX} y=${p1?.positionY}`
  )
  const persisted = await evalJs(
    cdp,
    `JSON.parse(localStorage.getItem('live2d_config'))?.state?.avatars?.kurisu ?? null`
  )
  report(
    '拖动后摆位写入 live2d_config',
    !!persisted && persisted.positionX === p1?.positionX && persisted.positionY === p1?.positionY,
    JSON.stringify(persisted)
  )
  const pokes = await evalJs(cdp, `window.__probe.pokes`)
  report('拖动松手不触发戳一戳', pokes === 0, `perform 调用 ${pokes} 次`)

  // —— 2. 边界：往右下角猛拖，模型画布至少三成留在舞台内 ——
  await evalJs(cdp, `window.__amadeus.live2dStore.getState().setAvatar({ positionX: 0, positionY: 0 })`)
  await sleep(100)
  let point = await hitPoint(cdp)
  await mouse(cdp, 'mousePressed', point.x, point.y)
  for (let i = 1; i <= 10; i++) await mouse(cdp, 'mouseMoved', point.x + i * 400, point.y + i * 400)
  await mouse(cdp, 'mouseReleased', point.x + 4000, point.y + 4000)
  const pc = await avatar(cdp, 'kurisu')
  const size = await evalJs(cdp, `window.__live2d.getModelSize()`)
  const w = size.width * pc.scale
  const h = size.height * pc.scale
  const cx = hit.stage.width / 2 + pc.positionX
  const cy = hit.stage.height / 2 + pc.positionY
  const keep = 0.3
  report(
    '右下猛拖后至少三成留在舞台内',
    cx <= hit.stage.width - w * keep + w / 2 + 1 &&
      cy <= hit.stage.height - h * keep + h / 2 + 1 &&
      cx >= w * keep - w / 2 - 1 &&
      cy >= h * keep - h / 2 - 1,
    `center=(${Math.round(cx)},${Math.round(cy)}) stage=${Math.round(hit.stage.width)}×${Math.round(hit.stage.height)}`
  )

  // —— 3. 边界：往左上角猛拖 ——
  await evalJs(cdp, `window.__amadeus.live2dStore.getState().setAvatar({ positionX: 0, positionY: 0 })`)
  await sleep(100)
  point = await hitPoint(cdp)
  await mouse(cdp, 'mousePressed', point.x, point.y)
  for (let i = 1; i <= 10; i++) await mouse(cdp, 'mouseMoved', point.x - i * 400, point.y - i * 400)
  await mouse(cdp, 'mouseReleased', point.x - 4000, point.y - 4000)
  const pc2 = await avatar(cdp, 'kurisu')
  const cx2 = hit.stage.width / 2 + pc2.positionX
  const cy2 = hit.stage.height / 2 + pc2.positionY
  report(
    '左上猛拖后至少三成留在舞台内',
    cx2 >= w * keep - w / 2 - 1 && cy2 >= h * keep - h / 2 - 1,
    `center=(${Math.round(cx2)},${Math.round(cy2)})`
  )

  // —— 3.5 配置面板滑块走同一条 store 写入：越界值同样夹回可见范围 ——
  await evalJs(cdp, `window.__amadeus.live2dStore.getState().setAvatar({ positionX: 1200, positionY: 1200 })`)
  const sliderClamped = await waitFor(
    cdp,
    `(() => {
      const a = ${avatarExpr('kurisu')}
      const w = ${size.width} * a.scale
      const h = ${size.height} * a.scale
      const cx = ${hit.stage.width} / 2 + a.positionX
      const cy = ${hit.stage.height} / 2 + a.positionY
      return cx <= ${hit.stage.width} - w * 0.3 + w / 2 + 1 && cy <= ${hit.stage.height} - h * 0.3 + h / 2 + 1 ? a : null
    })()`,
    3000,
    '滑块越界被夹回'
  ).catch(() => null)
  report('配置面板越界摆位被夹回', !!sliderClamped, JSON.stringify(sliderClamped))

  // —— 4. 滚轮缩放：比例变化、持久化、极端值被夹住 ——
  // 滚轮事件经 CDP 派发后异步处理：每一步都等 store 出现预期变化，不能立刻读
  const startScale = 0.25
  await evalJs(
    cdp,
    `window.__amadeus.live2dStore.getState().setAvatar({ positionX: 0, positionY: 0, scale: ${startScale} })`
  )
  await waitFor(
    cdp,
    `Math.abs(${avatarExpr('kurisu')}.scale - ${startScale}) < 1e-9`,
    3000,
    '缩放初值生效'
  )
  point = await hitPoint(cdp)
  await wheel(cdp, point.x, point.y, -240)
  const s1 = await waitFor(
    cdp,
    `(() => { const s = ${avatarExpr('kurisu')}.scale; return s > ${startScale} ? s : null })()`,
    3000,
    '滚轮向上放大'
  ).catch(() => null)
  await wheel(cdp, point.x, point.y, 480)
  const s2 = await waitFor(
    cdp,
    `(() => { const s = ${avatarExpr('kurisu')}.scale; return s < ${JSON.stringify(s1)} ? s : null })()`,
    3000,
    '滚轮向下缩小'
  ).catch(() => null)
  report(
    '滚轮向上放大 / 向下缩小',
    s1 !== null && s2 !== null,
    `${startScale} → ${s1?.toFixed(3)} → ${s2?.toFixed(3)}`
  )
  const scalePersisted = await evalJs(
    cdp,
    `JSON.parse(localStorage.getItem('live2d_config'))?.state?.avatars?.kurisu?.scale ?? null`
  )
  report('滚轮缩放写入 live2d_config', s2 !== null && Math.abs((scalePersisted ?? 0) - s2) < 1e-9, `stored=${scalePersisted}`)

  const maxAllowed = (hit.stage.height * 1.5) / size.height
  const minAllowed = (hit.stage.height * 0.2) / size.height
  await wheel(cdp, point.x, point.y, -100000)
  const sMax = await waitFor(
    cdp,
    `(() => { const s = ${avatarExpr('kurisu')}.scale; return Math.abs(s - ${maxAllowed}) < 1e-9 ? s : null })()`,
    3000,
    '滚轮上限生效'
  ).catch(async () => (await avatar(cdp, 'kurisu')).scale)
  await wheel(cdp, point.x, point.y, 100000)
  const sMin = await waitFor(
    cdp,
    `(() => { const s = ${avatarExpr('kurisu')}.scale; return Math.abs(s - ${minAllowed}) < 1e-9 ? s : null })()`,
    3000,
    '滚轮下限生效'
  ).catch(async () => (await avatar(cdp, 'kurisu')).scale)
  report(
    '极端滚轮夹在舞台高度的 20%~150%',
    Math.abs(sMax - maxAllowed) < 1e-6 && Math.abs(sMin - minAllowed) < 1e-6,
    `min=${sMin.toFixed(4)}/${minAllowed.toFixed(4)} max=${sMax.toFixed(4)}/${maxAllowed.toFixed(4)}`
  )

  // 留一个可辨认的摆位，供刷新后恢复断言
  await evalJs(
    cdp,
    `window.__amadeus.live2dStore.getState().setAvatar({ positionX: 123, positionY: -45, scale: ${startScale} })`
  )
  await waitFor(
    cdp,
    `${avatarExpr('kurisu')}.positionX === 123 && ${avatarExpr('kurisu')}.positionY === -45`,
    3000,
    '刷新前摆位落定'
  )
  const beforeReload = await avatar(cdp, 'kurisu')

  // —— 5. 刷新后从 live2d_config 恢复摆位 ——
  await cdp.call('Page.reload', {})
  await waitFor(cdp, `Boolean(window.__amadeus?.live2dStore)`, 20000, '重载后 store 就绪')
  await dismissLogin(cdp)
  await waitEngine(cdp, 'kurisu')
  const afterReload = await avatar(cdp, 'kurisu')
  report(
    '刷新后恢复摆位（位置与缩放）',
    afterReload.positionX === beforeReload.positionX &&
      afterReload.positionY === beforeReload.positionY &&
      afterReload.scale === beforeReload.scale,
    JSON.stringify(afterReload)
  )
} catch (error) {
  report('执行过程', false, error instanceof Error ? error.message : String(error))
} finally {
  // 用户数据还原：只有确实读到过原始值才动它
  if (configCaptured) {
    const put = (key, value) =>
      value === null
        ? `localStorage.removeItem(${JSON.stringify(key)})`
        : `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
    await evalJs(
      cdp,
      `(() => { ${put('live2d_config', originalConfig)}; ${put('live2d_config.bak', originalBak)}; return true })()`
    ).catch(() => {})
  }
  // 先还原原始字节再刷新：内存里的测试摆位不会再写回 localStorage
  await cdp.call('Page.reload', {}).catch(() => {})
  cdp.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 1)
