/**
 * 文本附件 + 消息分支树 E2E（CDP 驱动真实 Electron 应用）：
 *  1. 输入区附加一个文本文件与一张图片 → 真实附件 chip → 发送
 *  2. 模型读到文本附件并回答；用户消息渲染图片/文件；服务端返回附件与媒体字节
 *  3. 刷新后附件从服务端重新渲染
 *  4. 编辑用户消息 → 生成第二条分支；分支切换器 2/2，切回 1/2 再切回 2/2
 *  5. 重新生成助手回复 → 助手消息出现 2/2 分支并可切回
 *
 * 前置：brain（默认 3002）与桌面端 dev（CDP 默认 9222，可用 CDP_HTTP 覆盖）已启动。
 * 测试自建用户/会话与临时文件，结束统一清理。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3QCwAAAABJRU5ErkJggg=='
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
async function api(path, options) {
  const res = await fetch(`${BRAIN}${path}`, options)
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text }
  }
}
async function jsonApi(path, method, body) {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
const target = targets.find((item) => item.type === 'page')
if (!target) {
  console.error('未找到 Electron 页面目标。确认桌面端 dev 已启动。')
  process.exit(1)
}
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
  ws.onerror = (error) => reject(new Error(`CDP 失败: ${error.message}`))
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resP, rej } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) rej(new Error(message.error.message))
      else resP(message.result)
    }
  }
})
async function evalJs(expression) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await cdp.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (result.exceptionDetails) {
        throw new Error(
          `页面脚本异常: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`
        )
      }
      return result.result.value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        attempt < 2 &&
        /Promise was collected|Cannot find context|Execution context was destroyed/i.test(message)
      ) {
        await sleep(200)
        continue
      }
      throw error
    }
  }
}
async function waitFor(expression, timeoutMs = 30_000, label = expression) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(expression)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(200)
  }
}
async function setFiles(selector, files) {
  await cdp.call('DOM.enable')
  const { root } = await cdp.call('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) throw new Error('找不到文件输入框')
  await cdp.call('DOM.setFileInputFiles', { files, nodeId })
}
const setText = (selector, value) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`

const stamp = Date.now()
const username = `e2e-att-${stamp}`
const uniqueCode = `BLUEBIRD-${String(stamp).slice(-4)}`
const dir = mkdtempSync(join(tmpdir(), 'amadeus-att-e2e-'))
const textPath = join(dir, 'notes.txt')
const imagePath = join(dir, 'dot.png')
writeFileSync(textPath, `PROJECT_CODENAME = ${uniqueCode}\nOWNER = MAKISE\n`)
writeFileSync(imagePath, Buffer.from(PNG_1PX, 'base64'))

let userId = ''
let sessionId = ''
async function cleanup() {
  if (sessionId) {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {})
  }
  rmSync(dir, { recursive: true, force: true })
}
let cleaned = false
async function cleanupOnce() {
  if (cleaned) return
  cleaned = true
  await cleanup().catch((error) =>
    console.warn(`[e2e] 清理失败：${error instanceof Error ? error.message : error}`)
  )
}
process.on('SIGINT', () => void cleanupOnce().then(() => process.exit(130)))
process.on('SIGTERM', () => void cleanupOnce().then(() => process.exit(143)))

try {
  const login = await jsonApi('/api/users/login', 'POST', { username })
  userId = login.body.userId
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().userId === ${JSON.stringify(userId)}`,
    20_000,
    '身份同步'
  )
  await evalJs(`window.history.pushState({}, '', '/text'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(1500)
  sessionId = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  await waitFor(`!!document.querySelector('[data-testid="attach-input"]')`, 10_000, '输入区')

  // ---------- 1. 附加文件并发送 ----------
  await setFiles('[data-testid="attach-input"]', [textPath, imagePath])
  await waitFor(
    `document.querySelectorAll('[data-testid="attachment-chip"]').length === 2`,
    10_000,
    '附件 chip'
  )
  report('附件：文件与图片进入待发送列表', true)

  await evalJs(setText('textarea', '附件里的项目代号是什么？只回答代号。'))
  await evalJs(`document.querySelector('form button[type="submit"]').click(); true`)
  await waitFor(
    `(() => {
      const s = window.__amadeus.sessionStore.getState();
      const messages = s.messages[${JSON.stringify(sessionId)}] ?? [];
      return !s.stream.streaming && messages.some((m) => m.role === 'assistant');
    })()`,
    180_000,
    '附件回合'
  )
  const answer = await evalJs(
    `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}]
      .filter((m) => m.role === 'assistant').at(-1)?.content ?? ''`
  )
  report('附件：模型读到了文本文件内容', String(answer).includes(uniqueCode), String(answer).slice(0, 60))

  await waitFor(`!!document.querySelector('[data-testid="message-attachments"]')`, 10_000, '附件渲染')
  const rendered = await evalJs(
    `document.querySelector('[data-testid="message-attachments"]')?.innerText ?? ''`
  )
  report(
    '附件：用户消息显示图片与文件',
    (await evalJs(`document.querySelectorAll('[data-testid="message-attachments"] img').length`)) >= 1 &&
      String(rendered).includes('notes.txt')
  )

  let serverMessages = await api(`/api/sessions/${sessionId}/messages`)
  const userMessage = serverMessages.body.messages?.find((message) => message.role === 'user')
  report(
    '附件：服务端返回附件元数据',
    userMessage?.attachments?.length === 2 &&
      userMessage.attachments.some((item) => item.kind === 'file') &&
      userMessage.attachments.some((item) => item.kind === 'image')
  )
  const fileAttachment = userMessage.attachments.find((item) => item.kind === 'file')
  const media = await fetch(`${BRAIN}${fileAttachment.url}`)
  const mediaText = await media.text()
  report('附件：媒体接口返回真实文件字节', media.ok && mediaText.includes(uniqueCode))

  // ---------- 2. 刷新后仍可见 ----------
  await cdp.call('Page.reload', {})
  await sleep(3500)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().userId === ${JSON.stringify(userId)}`,
    20_000,
    '刷新身份'
  )
  await evalJs(`window.history.pushState({}, '', '/text'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(1200)
  await evalJs(`window.__amadeus.sessionStore.getState().selectSession(${JSON.stringify(sessionId)})`)
  await waitFor(`!!document.querySelector('[data-testid="message-attachments"]')`, 10_000, '刷新后附件')
  report('附件：刷新后从服务端重新渲染', true)

  // ---------- 3. 编辑生成分支 ----------
  await evalJs(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="edit-message"]')]
    buttons.at(-1)?.click()
    return true
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="edit-message-input"]')`, 5_000, '编辑框')
  await evalJs(setText('[data-testid="edit-message-input"]', '只回复：分支二'))
  await evalJs(`document.querySelector('[data-testid="edit-message-save"]').click(); true`)
  await waitFor(
    `(() => {
      const s = window.__amadeus.sessionStore.getState();
      const messages = s.messages[${JSON.stringify(sessionId)}] ?? [];
      return !s.stream.streaming && messages.at(-1)?.role === 'assistant' &&
        messages[0]?.content === '只回复：分支二';
    })()`,
    180_000,
    '编辑分支完成'
  )
  await waitFor(
    `document.querySelector('[data-testid="branch-switcher"]')?.textContent?.includes('2/2')`,
    15_000,
    '用户分支 2/2'
  )
  report('分支：编辑后用户消息显示 2/2', true)

  await evalJs(`document.querySelector('[data-testid="branch-prev"]')?.click(); true`)
  await waitFor(
    `(() => {
      const messages = window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}] ?? [];
      return messages[0]?.content?.includes('附件里的项目代号') ?? false;
    })()`,
    15_000,
    '切回分支 1'
  )
  report(
    '分支：切回旧分支看到原始提问',
    (await evalJs(`document.querySelector('[data-testid="branch-switcher"]')?.textContent`))?.includes('1/2')
  )

  await evalJs(`document.querySelector('[data-testid="branch-next"]')?.click(); true`)
  await waitFor(
    `(() => {
      const messages = window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sessionId)}] ?? [];
      return messages[0]?.content === '只回复：分支二';
    })()`,
    15_000,
    '切回分支 2'
  )
  report('分支：再切回新分支', true)

  // ---------- 4. 重新生成形成助手分支 ----------
  await evalJs(`document.querySelector('[data-testid="regenerate"]')?.click(); true`)
  await waitFor(
    `(() => {
      const s = window.__amadeus.sessionStore.getState();
      const messages = s.messages[${JSON.stringify(sessionId)}] ?? [];
      return !s.stream.streaming &&
        (document.querySelector('[data-testid="branch-switcher"]')?.textContent ?? '').includes('2/2');
    })()`,
    180_000,
    '重新生成分支'
  )
  serverMessages = await api(`/api/sessions/${sessionId}/messages`)
  const assistant = serverMessages.body.messages?.find((message) => message.role === 'assistant')
  report(
    '分支：重新生成产生 2/2 助手分支',
    assistant?.branchCount === 2 && assistant?.branchIndex === 2
  )
  await evalJs(`document.querySelector('[data-testid="branch-prev"]')?.click(); true`)
  await sleep(800)
  const afterSwitch = await api(`/api/sessions/${sessionId}/messages`)
  report(
    '分支：助手分支可切回 1/2',
    afterSwitch.body.messages?.find((message) => message.role === 'assistant')?.branchIndex === 1
  )
} catch (error) {
  console.error('E2E 异常：', error)
  report('脚本执行完成', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupOnce()
  cdp.close()
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
if (passed !== results.length) process.exitCode = 1
