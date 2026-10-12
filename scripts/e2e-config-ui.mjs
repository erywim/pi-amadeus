/**
 * 配置单一来源 UI E2E：
 *  1. 设置页 AI 表单从大脑服务加载（baseUrl/model 回填、密钥占位提示）
 *  2. 修改 model → 保存 → toast 提示 → 服务端 GET 确认落库
 *  3. Live2D 配置面板 AI tab 显示同一份服务端配置
 */
import { setTimeout as sleep } from 'node:timers/promises'

const BRAIN = 'http://localhost:3002'
const CDP_HTTP = 'http://127.0.0.1:9222'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const res = await fetch(`${CDP_HTTP}/json/list`)
const targets = await res.json()
const target = targets.find((t) => t.type === 'page')
const cdp = await new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onopen = () =>
    resolve({
      call(method, params = {}) {
        return new Promise((resP, rej) => {
          const callId = ++id
          pending.set(callId, { resP, rej })
          ws.send(JSON.stringify({ id: callId, method, params }))
        })
      },
      close: () => ws.close()
    })
  ws.onerror = (e) => reject(new Error(`CDP 失败: ${e.message}`))
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const { resP, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(msg.error.message))
      else resP(msg.result)
    }
  }
})
async function evalJs(expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`页面脚本异常: ${r.exceptionDetails.text}`)
  return r.result.value
}
async function waitFor(expression, timeoutMs = 30000, label = expression) {
  const start = Date.now()
  for (;;) {
    const v = await evalJs(expression)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(150)
  }
}

try {
  await cdp.call('Runtime.enable')
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(`window.__amadeus?.sessionStore.getState().userId`, 20000, 'userId')
  const userId = await evalJs(`window.__amadeus.sessionStore.getState().userId`)
  console.log(`userId: ${userId}`)

  console.log('\n=== 1. 设置页表单加载 ===')
  await evalJs(`window.history.pushState({}, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await waitFor(`document.querySelector('#ai-base-url') !== null`, 10000, '表单渲染')
  await waitFor(`document.querySelector('#ai-base-url').value !== ''`, 10000, '表单回填')
  const baseUrl = await evalJs(`document.querySelector('#ai-base-url').value`)
  const model = await evalJs(`document.querySelector('#ai-model').value`)
  const keyPlaceholder = await evalJs(`document.querySelector('#ai-api-key').placeholder`)
  report('baseUrl 从服务端回填', baseUrl === 'https://api.deepseek.com/v1', baseUrl)
  report('model 从服务端回填', model === 'deepseek-v4-pro', model)
  report('密钥占位提示"服务端默认密钥已生效"', keyPlaceholder.includes('默认密钥'), keyPlaceholder)
  const keyValue = await evalJs(`document.querySelector('#ai-api-key').value`)
  report('密钥输入框不回填（空）', keyValue === '')

  console.log('\n=== 2. 修改 model → 保存 → 落库 ===')
  const newModel = `deepseek-v4-pro-configtest-${Date.now()}`
  await evalJs(`(() => {
    const input = document.querySelector('#ai-model');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${newModel}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(300)
  // 点击保存按钮（含"保存"文案的按钮）
  const clicked = await evalJs(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const btn = buttons.find((b) => b.textContent.trim() === '保存');
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  report('点击保存按钮', clicked === true)
  await waitFor(
    `document.body.textContent.includes('已保存到大脑服务')`,
    15000,
    'toast 已保存到大脑服务'
  )
  report('toast 提示已保存', true)
  const g = await (await fetch(`${BRAIN}/api/config/${userId}`)).json()
  report('服务端 GET 确认 model 落库', g.config.provider.model === newModel, g.config.provider.model)
  // 还原 model，避免影响后续 E2E
  await fetch(`${BRAIN}/api/config/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { provider: { model: 'deepseek-v4-pro' } } })
  })

  console.log('\n=== 3. Live2D 配置面板 AI tab 同源显示 ===')
  await evalJs(`window.history.pushState({}, '', '/companion'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(2500)
  await evalJs(`window.__amadeus.uiStore.getState().setConfigPanelOpen(true, 'ai'); true`)
  await sleep(500)
  const panelText = await evalJs(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
  report('配置面板 AI tab 打开', panelText.length > 0)
  report('面板显示服务端 model（与保存值一致）', panelText.includes(newModel), newModel)
  await evalJs(`window.__amadeus.uiStore.getState().setConfigPanelOpen(false); true`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  cdp.close()
}
