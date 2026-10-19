/**
 * 桌宠模式 E2E（CDP 驱动真实桌面端 dev；不依赖 brain）。
 *
 * 覆盖的操作序列：
 *  1. 陪伴页 HUD 点「桌宠模式」→ 透明置顶窗口铺满主窗口所在显示器工作区，主窗口隐藏
 *  2. 进入时主窗口停掉自己的语音 I/O（麦克风/摄像头状态复位）
 *  3. 桌宠窗口里请求回到窗口模式 → 桌宠窗口销毁、主窗口恢复
 *  4. 再进再出一轮（状态不残留）
 *  5. 切换途中改主意：进入请求后、桌宠窗口就绪前立刻切回 → 不残留桌宠窗口
 *  6. 鼠标穿透：光标到脸上 → 接收鼠标；到空白 → 穿透；强制穿透时一律穿透；
 *     命中检测与实际渲染像素对照（一致率、可见像素零漏判）
 *  7. 拖动（按住期间拖出网格仍接收鼠标）/ 点按反应 / 边界限制 / 位置记忆与重进恢复 /
 *     pet_config 损坏回落默认位置且现场另存（测完按原始字节还原 pet_config）
 *
 * 前置：桌面端 dev 已启动（CDP 端口默认 9222，可用 CDP_HTTP 覆盖）。
 * 用法：node scripts/e2e-pet.mjs
 * 主进程窗口状态经 dev 专用的 window.api.debug.state() 读取；光标用 debug.petCursor
 * 覆盖坐标驱动，不移动用户的真实鼠标。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function pages() {
  const res = await fetch(`${CDP_HTTP}/json/list`)
  return (await res.json()).filter((t) => t.type === 'page')
}

const isPetUrl = (url) => url.includes('window=pet')

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
    // 目标页被销毁（如桌宠窗口退出）时，挂起中的调用立即失败，不让脚本卡死
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

async function waitFor(cdp, expression, timeoutMs = 15000, label = expression) {
  const start = Date.now()
  for (;;) {
    const v = await evalJs(cdp, expression).catch(() => null)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(150)
  }
}

/** 等某个页面目标出现/消失 */
async function waitForPage(pred, present, timeoutMs = 15000) {
  const start = Date.now()
  for (;;) {
    const hit = (await pages()).find((p) => pred(p.url))
    if (present ? hit : !hit) return hit ?? null
    if (Date.now() - start > timeoutMs) throw new Error(`等待页面${present ? '出现' : '消失'}超时`)
    await sleep(150)
  }
}

const debugState = (main) => evalJs(main, 'window.api.debug.state()')

async function enterPetViaHud(main) {
  const clicked = await evalJs(
    main,
    `(() => { const b = document.querySelector('button:has(svg.lucide-picture-in-picture-2)'); b?.click(); return !!b })()`
  )
  if (!clicked) throw new Error('陪伴页 HUD 上找不到桌宠模式按钮')
  const target = await waitForPage(isPetUrl, true)
  const pet = await connect(target.webSocketDebuggerUrl)
  await waitFor(main, `window.api.debug.state().then((s) => s.petShown)`, 15000, '桌宠窗口显示')
  return pet
}

/** 经 api 进入桌宠，并把覆盖光标放到窗口外（排除用户真实鼠标的干扰）；返回桌宠页连接 */
async function enterPet(main) {
  await evalJs(main, `window.api.setMode('pet'); true`)
  const target = await waitForPage(isPetUrl, true)
  await evalJs(main, `window.api.debug.petCursor({ x: -10000, y: -10000 })`)
  const pet = await connect(target.webSocketDebuggerUrl)
  await waitFor(main, `window.api.debug.state().then((s) => s.petShown)`, 15000, '桌宠窗口显示')
  await waitFor(pet, `!!window.__live2d?.getPlacement()`, 10000, '角色就位')
  return pet
}

async function exitPet(fromCdp, main) {
  // 请求会销毁发起它的页面：不等这次求值的返回
  evalJs(fromCdp, `window.api.setMode('window'); true`).catch(() => undefined)
  await waitForPage(isPetUrl, false)
  // macOS 先恢复 Dock 图标再显示主窗口（异步）：条件等待，不靠固定延时
  await waitFor(main, `window.api.debug.state().then((s) => s.main?.visible)`, 5000, '主窗口恢复可见').catch(() => undefined)
}

let main = null
try {
  const mainTarget = (await pages()).find((p) => !isPetUrl(p.url))
  if (!mainTarget) throw new Error(`${CDP_HTTP} 上没有主窗口页面（桌面端 dev 未启动？）`)
  main = await connect(mainTarget.webSocketDebuggerUrl)
  await waitFor(main, `typeof window.api?.debug?.state === 'function'`, 10000, 'dev 调试接口')

  // 干净起点：窗口模式 + 陪伴页
  if ((await evalJs(main, 'window.api.getMode()')) !== 'window') {
    await evalJs(main, `window.api.setMode('window'); true`)
    await waitForPage(isPetUrl, false)
  }
  await evalJs(main, `(() => { const tab = [...document.querySelectorAll('[role=tab]')][0]; tab?.click(); return true })()`)
  await waitFor(main, `location.pathname === '/companion' && !!window.__live2d`, 20000, '陪伴页就绪')

  console.log('\n=== 1. 进入桌宠模式 ===')
  // 模拟主窗口语音 I/O 进行中，进入桌宠后应被复位
  await evalJs(main, `window.__amadeus.uiStore.getState().setMicActive(true); true`)
  const pet = await enterPetViaHud(main)
  const s1 = await debugState(main)
  report('模式切为 pet', s1.mode === 'pet')
  report('主窗口隐藏', s1.main?.visible === false)
  report('桌宠窗口可见且置顶', s1.pet?.visible === true && s1.pet?.alwaysOnTop === true)
  report(
    '桌宠窗口铺满所在显示器工作区',
    JSON.stringify(s1.pet?.bounds) === JSON.stringify(s1.petWorkArea),
    `${JSON.stringify(s1.pet?.bounds)} vs ${JSON.stringify(s1.petWorkArea)}`
  )
  const bg = await evalJs(pet, `[getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]`)
  report('桌宠页面背景透明', bg.every((c) => c === 'rgba(0, 0, 0, 0)'), bg.join(' / '))
  const placed = await evalJs(pet, `(() => { const m = window.__live2d?.model; return !!m && m.scale.x > 0 && m.x > 0 && m.x < innerWidth && m.y > 0 && m.y < innerHeight })()`)
  report('角色已摆进窗口内', placed)
  report('托盘单选跟随（桌宠模式勾选）', s1.tray?.[1]?.checked === true && s1.tray?.[0]?.checked === false)
  report('主窗口麦克风状态已复位', (await evalJs(main, 'window.__amadeus.uiStore.getState().micActive')) === false)

  console.log('\n=== 2. 回到窗口模式 ===')
  await exitPet(pet, main)
  pet.close()
  const s2 = await debugState(main)
  report('模式切回 window', s2.mode === 'window')
  report('主窗口恢复可见', s2.main?.visible === true)
  report('桌宠窗口已销毁', s2.pet === null)
  report('托盘单选跟随（窗口模式勾选）', s2.tray?.[0]?.checked === true && s2.tray?.[1]?.checked === false)

  console.log('\n=== 3. 再进再出一轮 ===')
  const pet2 = await enterPetViaHud(main)
  report('第二次进入同样显示', (await debugState(main)).pet?.visible === true)
  await exitPet(pet2, main)
  pet2.close()
  report('第二次退出同样恢复', (await debugState(main)).main?.visible === true)

  console.log('\n=== 4. 切换途中改主意 ===')
  await evalJs(main, `window.api.setMode('pet'); window.api.setMode('window'); true`)
  // 桌宠窗口可能已创建：等它在就绪前被销毁
  await sleep(300)
  await waitForPage(isPetUrl, false)
  await sleep(1500) // 足够桌宠渲染层走完加载：若残留就绪回调，此时会错误地显示出来
  const s4 = await debugState(main)
  report('立即切回后停在窗口模式', s4.mode === 'window' && s4.pet === null && s4.main?.visible === true, JSON.stringify({ mode: s4.mode, pet: s4.pet }))

  console.log('\n=== 5. 托盘文案跟随界面语言 ===')
  // 语言偏好落在 localStorage：测完按原始字节还原（包括"原本不存在"），不改用户数据
  const saved = await evalJs(main, `({ lang: window.__amadeus.settingsStore.getState().language, settings: localStorage.getItem('amadeus_settings'), cache: localStorage.getItem('amadeus_lang') })`)
  try {
    await evalJs(main, `window.__amadeus.settingsStore.getState().setLanguage('en'); true`)
    const en = await waitFor(main, `window.api.debug.state().then((s) => s.tray[0].label === 'Window Mode' ? s.tray : null)`, 5000, '托盘英文')
    report('切到英文后托盘为英文', en[1]?.label === 'Desktop Pet Mode', en.map((i) => i.label).join(' / '))
  } finally {
    await evalJs(
      main,
      `(() => {
        const saved = ${JSON.stringify(saved)}
        window.__amadeus.settingsStore.getState().setLanguage(saved.lang)
        const put = (k, v) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v))
        put('amadeus_settings', saved.settings)
        put('amadeus_lang', saved.cache)
        return true
      })()`
    )
  }
  const back = await waitFor(main, `window.api.debug.state().then((s) => (s.tray[0].label === 'Window Mode') === (${JSON.stringify(saved.lang)} === 'en') ? s.tray : null)`, 5000, '托盘语言恢复')
  report('恢复原语言后托盘跟随', back.length > 0, back.map((i) => i.label).join(' / '))

  console.log('\n=== 6. 鼠标穿透：按命中区域切换 ===')
  // 光标用 dev 专用覆盖坐标驱动（不动用户真实鼠标），走的仍是主进程轮询 → 渲染层命中 → 主进程切换的完整链路
  const pet3 = await enterPet(main)
  try {
    const s6 = await debugState(main)
    const origin = s6.pet.bounds
    const face = await waitFor(pet3, `window.__live2d?.debugRegion('face')`, 10000, '脸部区域')
    const onFace = { x: Math.round(origin.x + face.x + face.width / 2), y: Math.round(origin.y + face.y + face.height / 2) }
    const empty = { x: origin.x + 40, y: origin.y + 40 }
    report('初始整窗穿透', s6.petCapturing === false)
    await evalJs(main, `window.api.debug.petCursor(${JSON.stringify(onFace)})`)
    report('光标移到脸上 → 接收鼠标', !!(await waitFor(main, `window.api.debug.state().then((s) => s.petCapturing)`, 3000, '命中切换').catch(() => false)))
    await evalJs(main, `window.api.debug.petCursor(${JSON.stringify(empty)})`)
    report('光标移到空白 → 恢复穿透', !!(await waitFor(main, `window.api.debug.state().then((s) => !s.petCapturing)`, 3000, '离开切换').catch(() => false)))

    await evalJs(main, `window.api.debug.petCursor(${JSON.stringify(onFace)})`)
    await waitFor(main, `window.api.debug.state().then((s) => s.petCapturing)`, 3000, '命中切换')
    await evalJs(main, `window.api.debug.petPassthrough(true)`)
    const forced = await debugState(main)
    report('强制穿透：光标在脸上也不接收', forced.petCapturing === false && forced.petPassthroughForced === true)
    report('托盘「鼠标穿透」勾选', forced.tray.some((i) => i.checked === true && /穿透|Passthrough|透過/.test(i.label)))
    await evalJs(main, `window.api.debug.petPassthrough(false)`)
    report('关闭强制穿透后恢复命中', (await debugState(main)).petCapturing === true)

    // 命中检测与实际渲染像素对照：渲染后同一任务内 readPixels，包围盒内均匀采样
    const cmp = await evalJs(
      pet3,
      `(() => {
        const e = window.__live2d, app = e.app, r = app.renderer, gl = r.gl, res = r.resolution
        r.render(app.stage)
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight
        const buf = new Uint8Array(W * H * 4)
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        const b = e.model.getBounds()
        let total = 0, agree = 0, missed = 0
        for (let y = Math.max(0, b.y); y < Math.min(innerHeight, b.y + b.height); y += 6) {
          for (let x = Math.max(0, b.x); x < Math.min(innerWidth, b.x + b.width); x += 6) {
            const visible = buf[((H - 1 - Math.floor(y * res)) * W + Math.floor(x * res)) * 4 + 3] > 20
            const hit = e.hitTest(x, y)
            total++
            if (visible === hit) agree++
            else if (visible) missed++
          }
        }
        return { total, agreement: agree / total, missed }
      })()`
    )
    report('命中与渲染像素一致率 ≥ 97%', cmp.agreement >= 0.97, `${(cmp.agreement * 100).toFixed(2)}%（${cmp.total} 点）`)
    report('可见像素无漏判', cmp.missed === 0, `漏判 ${cmp.missed}`)
  } finally {
    await evalJs(main, `window.api.debug.petPassthrough(false).then(() => window.api.debug.petCursor(null))`).catch(() => undefined)
    await exitPet(pet3, main)
    pet3.close()
  }

  console.log('\n=== 7. 拖动 / 点按 / 位置记忆 ===')
  // pet_config 是用户数据：测完按原始字节还原（含"原本不存在"），本节产生的 .bad-* 一并删除
  const savedCfg = await evalJs(main, `({ raw: localStorage.getItem('pet_config'), bak: localStorage.getItem('pet_config.bak'), bad: Object.keys(localStorage).filter((k) => k.startsWith('pet_config.bad-')) })`)
  try {
    await evalJs(main, `localStorage.removeItem('pet_config'); localStorage.removeItem('pet_config.bak'); true`)
    let pet = await enterPet(main)
    const o = (await debugState(main)).pet.bounds
    const mouse = (type, x, y) =>
      pet.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
    const facePoint = async () => {
      const f = await evalJs(pet, `window.__live2d.debugRegion('face')`)
      return { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) }
    }
    const placement = () => evalJs(pet, `window.__live2d.getPlacement()`)
    // 真实操作里按下前光标必然先悬停在角色上：用覆盖坐标模拟悬停，让窗口先接收鼠标
    const hoverAt = async (p) => {
      await evalJs(main, `window.api.debug.petCursor(${JSON.stringify({ x: o.x + p.x, y: o.y + p.y })})`)
      await waitFor(main, `window.api.debug.state().then((s) => s.petCapturing)`, 3000, '悬停接收')
    }

    const p0 = await placement()
    let f = await facePoint()
    await hoverAt(f)
    await mouse('mousePressed', f.x, f.y)
    for (let i = 1; i <= 10; i++) await mouse('mouseMoved', f.x - i * 15, f.y - i * 5)
    // 拖动途中光标离开角色网格：按住期间仍须接收鼠标，否则拖动会断
    await evalJs(main, `window.api.debug.petCursor(${JSON.stringify({ x: o.x + 40, y: o.y + 40 })})`)
    await sleep(250)
    report('拖出网格时仍接收鼠标', (await debugState(main)).petCapturing === true)
    await mouse('mouseReleased', f.x - 150, f.y - 50)
    const p1 = await placement()
    report('拖动后角色跟随指针', Math.round(p1.x - p0.x) === -150 && Math.round(p1.y - p0.y) === -50, `dx=${Math.round(p1.x - p0.x)} dy=${Math.round(p1.y - p0.y)}`)
    report('松手后光标在空白处 → 恢复穿透', !!(await waitFor(main, `window.api.debug.state().then((s) => !s.petCapturing)`, 3000, '松手穿透').catch(() => false)))
    const stored = await evalJs(pet, `JSON.parse(localStorage.getItem('pet_config') ?? 'null')?.state?.placement ?? null`)
    report('松手后记住位置（相对窗口的比例）', !!stored && Math.abs(stored.fx * o.width - p1.x) < 1 && Math.abs(stored.fy * o.height - p1.y) < 1, JSON.stringify(stored))

    f = await facePoint()
    await hoverAt(f)
    const motionBefore = await evalJs(pet, `window.__live2d.isMotionPlaying()`)
    await mouse('mousePressed', f.x, f.y)
    await mouse('mouseReleased', f.x, f.y)
    const tapped = await waitFor(pet, `window.__live2d.isMotionPlaying()`, 2000, '点按反应').catch(() => false)
    report('点按 → 播放反应手势', motionBefore === false && tapped === true)
    const p2 = await placement()
    report('点按不移动角色', p2.x === p1.x && p2.y === p1.y)

    // 往窗口外猛拖：位置被限制在窗口内（模型画布至少三成留在窗口里）
    f = await facePoint()
    await hoverAt(f)
    await mouse('mousePressed', f.x, f.y)
    for (let i = 1; i <= 10; i++) await mouse('mouseMoved', f.x + i * 400, f.y + i * 400)
    await mouse('mouseReleased', f.x + 4000, f.y + 4000)
    const pc = await placement()
    const size = await evalJs(pet, `window.__live2d.getModelSize()`)
    const w = size.width * pc.scale
    const h = size.height * pc.scale
    report('拖出边界被限制', pc.x <= o.width - w * 0.3 + w / 2 + 0.5 && pc.y <= o.height - h * 0.3 + h / 2 + 0.5, `x=${Math.round(pc.x)} y=${Math.round(pc.y)}`)

    await evalJs(main, `window.api.debug.petCursor(null)`)
    await exitPet(pet, main)
    pet.close()
    pet = await enterPet(main)
    const pr = await placement()
    report('重进桌宠恢复上次位置', Math.abs(pr.x - pc.x) < 1 && Math.abs(pr.y - pc.y) < 1, `(${Math.round(pr.x)}, ${Math.round(pr.y)})`)
    await exitPet(pet, main)
    pet.close()

    // pet_config 被写坏：回落默认位置，损坏原文另存 .bad-*（不静默覆盖现场）
    await evalJs(main, `localStorage.removeItem('pet_config.bak'); localStorage.setItem('pet_config', '{broken-pet'); true`)
    pet = await enterPet(main)
    const pd = await placement()
    const view = await evalJs(pet, `[innerWidth, innerHeight]`)
    report('配置损坏 → 默认右下角', Math.abs(pd.x + (size.width * pd.scale) / 2 - view[0]) < 1 && Math.abs(pd.y + (size.height * pd.scale) / 2 - view[1]) < 1)
    report('损坏原文已另存 .bad-*', await evalJs(pet, `Object.keys(localStorage).some((k) => k.startsWith('pet_config.bad-') && localStorage.getItem(k) === '{broken-pet')`))
    await exitPet(pet, main)
    pet.close()
  } finally {
    await evalJs(
      main,
      `(() => {
        const saved = ${JSON.stringify(savedCfg)}
        const put = (k, v) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v))
        put('pet_config', saved.raw)
        put('pet_config.bak', saved.bak)
        for (const k of Object.keys(localStorage)) if (k.startsWith('pet_config.bad-') && !saved.bad.includes(k)) localStorage.removeItem(k)
        return true
      })()`
    ).catch(() => undefined)
  }
} catch (error) {
  report('执行', false, error instanceof Error ? error.message : String(error))
} finally {
  // 不留尾巴：无论成败都回到窗口模式
  if (main) {
    await evalJs(main, `window.__amadeus?.uiStore.getState().setMicActive(false); window.api.setMode('window'); true`).catch(() => undefined)
    main.close()
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) process.exitCode = 1
