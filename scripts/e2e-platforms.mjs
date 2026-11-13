/**
 * 通讯平台适配器 E2E（参考 AstrBot 的多平台接入）：
 *  1. Webhook 平台：密钥校验、入站 → 真实 agent 回合 → 出站回复、会话渠道标记、测试发送
 *  2. Telegram 平台：长轮询（本地 mock Bot API）、消息 → 回合 → sendMessage 回复、测试发送
 *  3. OneBot v11 平台：正向 WebSocket（本地 mock 服务端）、私聊事件 → 回合 →
 *     send_private_msg 回复、测试发送走 send_group_msg
 *
 * 前置：brain 已启动（默认 http://localhost:3002）且可用的 LLM（真实或 mock）。
 * 脚本自建本地 mock 服务与平台记录，结束统一清理；不依赖任何真实平台账号。
 */
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'
import { WebSocketServer } from 'ws'

const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const WEBHOOK_PORT = Number(process.env.E2E_WEBHOOK_PORT ?? '3998')
const TELEGRAM_PORT = Number(process.env.E2E_TELEGRAM_PORT ?? '3997')
const ONEBOT_PORT = Number(process.env.E2E_ONEBOT_PORT ?? '3996')

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
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(200)
  }
}

/** 连接 CDP 页面（桌面端管理界面用例用） */
function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl)
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
    ws.onerror = (event) => reject(new Error(`CDP 失败: ${event.message ?? 'unknown'}`))
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
}

// ---------- 本地 mock 服务 ----------

const webhookReceived = []
const webhookServer = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    webhookReceived.push(JSON.parse(body))
  } catch {
    /* 忽略非 JSON */
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"ok":true}')
})
await new Promise((resolve) => webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', resolve))

let telegramUpdates = []
const telegramSent = []
const telegramServer = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const method = new URL(req.url ?? '/', 'http://x').pathname.split('/').pop()
  if (method === 'getMe') {
    res.end(JSON.stringify({ ok: true, result: { username: 'amadeus_e2e_bot' } }))
    return
  }
  if (method === 'getUpdates') {
    const updates = telegramUpdates
    telegramUpdates = []
    // 模拟长轮询的空转间隔，避免适配器紧循环
    await sleep(300)
    res.end(JSON.stringify({ ok: true, result: updates }))
    return
  }
  if (method === 'sendMessage') {
    try {
      telegramSent.push(JSON.parse(body))
    } catch {
      /* ignore */
    }
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise((resolve) => telegramServer.listen(TELEGRAM_PORT, '127.0.0.1', resolve))

const oneBotServer = new WebSocketServer({ port: ONEBOT_PORT, host: '127.0.0.1' })
let oneBotSocket = null
const oneBotActions = []
oneBotServer.on('connection', (socket) => {
  oneBotSocket = socket
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(String(data))
      if (message.action) {
        oneBotActions.push(message)
        socket.send(
          JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: message.echo })
        )
      }
    } catch {
      /* ignore */
    }
  })
})
await sleep(200)

const createdPlatforms = []
const createdSessions = []

async function cleanup() {
  for (const id of createdPlatforms) {
    await api(`/api/platforms/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdSessions) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  webhookServer.close()
  telegramServer.close()
  oneBotServer.close()
}
let cleanupOnce = null
function cleanupPromise() {
  cleanupOnce ??= cleanup().catch((error) =>
    console.warn(`[e2e] 清理失败：${error instanceof Error ? error.message : error}`)
  )
  return cleanupOnce
}
process.on('SIGINT', () => void cleanupPromise().then(() => process.exit(130)))
process.on('SIGTERM', () => void cleanupPromise().then(() => process.exit(143)))

/** 外部账号自动建档后的用户 id（用于检查会话与清理） */
async function autoUserId(username) {
  const result = await api('/api/users/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
  return result.body.userId
}

try {
  // ================= Webhook =================
  let res = await api('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'webhook',
      name: 'E2E Webhook',
      config: { outboundUrl: `http://127.0.0.1:${WEBHOOK_PORT}/reply`, secret: 's3cret' }
    })
  })
  const webhookId = res.body.platform?.id
  createdPlatforms.push(webhookId)
  report(
    'Webhook：创建并运行',
    res.status === 200 && res.body.platform?.status?.state === 'running',
    `state=${res.body.platform?.status?.state}`
  )
  report('Webhook：密钥不回显', res.body.platform?.config?.secretSet === true && res.body.platform?.config?.secret === undefined)

  res = await api(`/api/platforms/${webhookId}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalUserId: 'u1', chatId: 'c1', text: '你好' })
  })
  report('Webhook：错误密钥被拒绝', res.status === 401)

  res = await api(`/api/platforms/${webhookId}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-amadeus-secret': 's3cret' },
    body: JSON.stringify({
      externalUserId: 'u1',
      chatId: 'c1',
      text: '你好，请用一句话介绍你自己'
    })
  })
  report('Webhook：合法入站被接受', res.status === 202)
  await waitFor(() => webhookReceived.length > 0, 60_000, 'webhook 回复')
  const webhookReply = webhookReceived[0]?.text ?? ''
  report(
    'Webhook：真实回合并回复到出站地址',
    webhookReply.length > 0 && !webhookReply.includes('连不上大脑'),
    webhookReply.slice(0, 60)
  )

  const webhookUser = await autoUserId('webhook-u1')
  const webhookSessions = (await api(`/api/sessions?userId=${webhookUser}`)).body.sessions ?? []
  createdSessions.push(...webhookSessions.map((session) => session.id))
  report(
    'Webhook：会话标记为 webhook 渠道',
    webhookSessions.length === 1 && webhookSessions[0].channel === 'webhook',
    `sessions=${webhookSessions.length}`
  )

  res = await api(`/api/platforms/${webhookId}/test`, { method: 'POST' })
  await waitFor(() => webhookReceived.length > 1, 10_000, 'webhook 测试发送')
  report('Webhook：测试发送', res.status === 200 && webhookReceived[1]?.type === 'message')

  // ================= Telegram =================
  res = await api('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'telegram',
      name: 'E2E Telegram',
      config: {
        token: '123:abc',
        baseUrl: `http://127.0.0.1:${TELEGRAM_PORT}`,
        testChatId: '42'
      }
    })
  })
  const telegramId = res.body.platform?.id
  createdPlatforms.push(telegramId)
  report(
    'Telegram：长轮询启动',
    res.status === 200 && res.body.platform?.status?.state === 'running',
    `state=${res.body.platform?.status?.state} detail=${res.body.platform?.status?.detail}`
  )

  telegramUpdates.push({
    update_id: 1,
    message: { text: '用一句话跟我打个招呼', chat: { id: 42, type: 'private' }, from: { id: 1001 } }
  })
  await waitFor(() => telegramSent.length > 0, 60_000, 'telegram 回复')
  report(
    'Telegram：消息 → 回合 → sendMessage',
    typeof telegramSent[0]?.text === 'string' &&
      telegramSent[0].text.length > 0 &&
      !telegramSent[0].text.includes('连不上大脑'),
    String(telegramSent[0]?.text ?? '').slice(0, 60)
  )
  report('Telegram：回复发给原会话', String(telegramSent[0]?.chat_id) === '42')

  const telegramUser = await autoUserId('telegram-1001')
  const telegramSessions = (await api(`/api/sessions?userId=${telegramUser}`)).body.sessions ?? []
  createdSessions.push(...telegramSessions.map((session) => session.id))
  report(
    'Telegram：会话标记为 telegram 渠道',
    telegramSessions.length === 1 && telegramSessions[0].channel === 'telegram'
  )

  res = await api(`/api/platforms/${telegramId}/test`, { method: 'POST' })
  await waitFor(() => telegramSent.length > 1, 10_000, 'telegram 测试发送')
  report(
    'Telegram：测试发送到配置的测试会话',
    res.status === 200 && String(telegramSent[1]?.chat_id) === '42'
  )

  // ================= OneBot v11 =================
  res = await api('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'onebot',
      name: 'E2E OneBot',
      config: { url: `ws://127.0.0.1:${ONEBOT_PORT}`, testChatId: 'group:12345' }
    })
  })
  const oneBotId = res.body.platform?.id
  createdPlatforms.push(oneBotId)
  report(
    'OneBot：正向 WebSocket 连接',
    res.status === 200 && res.body.platform?.status?.state === 'running',
    `state=${res.body.platform?.status?.state}`
  )
  await waitFor(() => oneBotSocket, 10_000, 'onebot 连接')

  oneBotSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      self_id: 1,
      user_id: 10001,
      message: [{ type: 'text', data: { text: '你好呀' } }]
    })
  )
  await waitFor(() => oneBotActions.some((action) => action.action === 'send_private_msg'), 60_000, 'onebot 回复')
  const oneBotReply = oneBotActions.find((action) => action.action === 'send_private_msg')
  report(
    'OneBot：私聊事件 → 回合 → send_private_msg',
    String(oneBotReply?.params?.message ?? '').length > 0 &&
      !String(oneBotReply?.params?.message).includes('连不上大脑'),
    String(oneBotReply?.params?.message ?? '').slice(0, 60)
  )
  report('OneBot：回复发给原用户', String(oneBotReply?.params?.user_id) === '10001')

  const oneBotUser = await autoUserId('onebot-10001')
  const oneBotSessions = (await api(`/api/sessions?userId=${oneBotUser}`)).body.sessions ?? []
  createdSessions.push(...oneBotSessions.map((session) => session.id))
  report(
    'OneBot：会话标记为 onebot 渠道',
    oneBotSessions.length === 1 && oneBotSessions[0].channel === 'onebot'
  )

  res = await api(`/api/platforms/${oneBotId}/test`, { method: 'POST' })
  await waitFor(
    () => oneBotActions.some((action) => action.action === 'send_group_msg'),
    10_000,
    'onebot 测试发送'
  )
  report(
    'OneBot：测试发送走群消息',
    res.status === 200 &&
      String(oneBotActions.find((action) => action.action === 'send_group_msg')?.params?.group_id) ===
        '12345'
  )
  // ================= 桌面端管理界面 =================
  const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
  let cdp = null
  try {
    const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
    const target = targets.find((item) => item.type === 'page')
    if (target) cdp = await connectCdp(target.webSocketDebuggerUrl)
  } catch {
    cdp = null
  }

  if (!cdp) {
    report('桌面端：通讯平台管理界面（跳过：CDP 不可用）', true, 'not run')
  } else {
    const evalJs = async (expression) => {
      const result = await cdp.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      }
      return result.result.value
    }
    const waitCdp = async (expression, timeoutMs, label) => {
      const start = Date.now()
      for (;;) {
        if (await evalJs(expression)) return true
        if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
        await sleep(200)
      }
    }
    const setInput = (selector, value) =>
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`

    const uiName = `E2E UI Webhook ${Date.now()}`
    await evalJs(`location.href = 'http://localhost:5173/settings'; true`)
    await sleep(2000)
    await waitCdp(`document.body.innerText.includes('通讯平台')`, 20000, '进入设置')
    await evalJs(`(() => { const b=[...document.querySelectorAll('nav button')].find(x=>x.textContent.includes('通讯平台')); b?.click(); return !!b })()`)
    await waitCdp(`!!document.querySelector('[data-testid="platform-add"]')`, 10000, '通讯平台面板')
    await evalJs(`document.querySelector('[data-testid="platform-add"]').click(); true`)
    await waitCdp(`!!document.querySelector('[data-testid="platform-kind-webhook"]')`, 5000, '新增弹窗')
    await evalJs(`document.querySelector('[data-testid="platform-kind-webhook"]').click(); true`)
    await evalJs(setInput('[data-testid="platform-name"]', uiName))
    await evalJs(setInput('[data-testid="platform-outbound-url"]', `http://127.0.0.1:${WEBHOOK_PORT}/ui`))
    await evalJs(setInput('[data-testid="platform-secret"]', 'ui-secret'))
    await evalJs(`document.querySelector('[data-testid="platform-save"]').click(); true`)
    const listed = await waitFor(
      async () => {
        const response = await api('/api/platforms')
        return response.body.platforms?.find((platform) => platform.name === uiName)
      },
      15000,
      '平台新增'
    ).catch(() => null)
    report('桌面端：新增通讯平台', Boolean(listed), listed ? `state=${listed.status?.state}` : '')
    if (listed) {
      createdPlatforms.push(listed.id)
      await waitCdp(
        `!!document.querySelector('[data-platform-id="${listed.id}"]')`,
        10000,
        '平台卡片'
      )
      const beforeTest = webhookReceived.length
      await evalJs(
        `document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-test"]').click(); true`
      )
      await waitFor(() => webhookReceived.length > beforeTest, 10_000, '界面测试发送').catch(() => {})
      report('桌面端：测试发送按钮', webhookReceived.length > beforeTest)

      await evalJs(
        `document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-edit"]').click(); true`
      )
      await waitCdp(`!!document.querySelector('[data-testid="platform-name"]')`, 5000, '编辑弹窗')
      const editedName = `${uiName} 已改名`
      await evalJs(setInput('[data-testid="platform-name"]', editedName))
      await evalJs(`document.querySelector('[data-testid="platform-save"]').click(); true`)
      const renamed = await waitFor(
        async () => {
          const response = await api('/api/platforms')
          return response.body.platforms?.find((platform) => platform.id === listed.id)?.name === editedName
        },
        15000,
        '平台改名'
      ).catch(() => false)
      report('桌面端：编辑平台', renamed === true)

      await evalJs(
        `document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-enabled"]').click(); true`
      )
      const disabled = await waitFor(
        async () => {
          const response = await api('/api/platforms')
          return response.body.platforms?.find((platform) => platform.id === listed.id)?.enabled === false
        },
        10000,
        '平台停用'
      ).catch(() => false)
      report('桌面端：启停开关', disabled === true)

      await evalJs(
        `document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-delete"]').click(); true`
      )
      await sleep(200)
      await evalJs(
        `document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-delete"]').click(); true`
      )
      const removed = await waitFor(
        async () => {
          const response = await api('/api/platforms')
          return !response.body.platforms?.some((platform) => platform.id === listed.id)
        },
        15000,
        '平台删除'
      ).catch(() => false)
      report('桌面端：删除平台', removed === true)
      if (removed) {
        const index = createdPlatforms.indexOf(listed.id)
        if (index >= 0) createdPlatforms.splice(index, 1)
      }
    }
    cdp.close()
  }
} catch (error) {
  report('执行中断', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupPromise()
}

const failed = results.filter((result) => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed > 0 ? 1 : 0)
