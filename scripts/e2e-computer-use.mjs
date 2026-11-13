/**
 * Computer Use 窗口执行器回归：不依赖 LLM，直接验证 Electron 主进程的受信 sender、
 * 截图、点击/滚动/输入校验和非法 sender 拒绝。需要桌面端 dev 已启动（9222）。
 * brain→LLM tool loop 的视觉结果依赖真实视觉模型，若未配置则明确 not run。
 */
const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'

const res = await fetch(`${CDP_HTTP}/json/list`)
if (!res.ok) throw new Error(`CDP 不可达: HTTP ${res.status}`)
const targets = await res.json()
const target = targets.find((item) => item.type === 'page')
if (!target) throw new Error('没有 Electron page target')

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  if (msg.error) entry.reject(new Error(msg.error.message))
  else entry.resolve(msg.result?.result?.value)
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

const report = []
async function check(name, expression) {
  const value = await evaluate(expression)
  report.push({ name, ok: Boolean(value), value })
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}${value ? '' : ` — ${JSON.stringify(value)}`}`)
}

await check('computer API 已暴露', 'Boolean(window.api?.computer?.execute)')
await check('截图返回当前窗口 image', `(async () => { const r = await window.api.computer.execute({ action: 'screenshot' }); return r.ok && r.screenshot?.surface === 'window' && r.screenshot.data.length > 100; })()`)
await check('非法超长 type 被主进程拒绝', `(async () => { const r = await window.api.computer.execute({ action: 'type', text: 'x'.repeat(2001) }); return !r.ok && r.error?.code === 'execution_failed'; })()`)
await check('非法坐标被主进程拒绝', `(async () => { const r = await window.api.computer.execute({ action: 'click', x: -1, y: 0 }); return !r.ok; })()`)

ws.close()
const failures = report.filter((item) => !item.ok)
if (failures.length) process.exitCode = 1
