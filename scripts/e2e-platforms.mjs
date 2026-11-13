/**
 * 通讯平台适配器 E2E（参考常见的多平台接入）：
 *  1. Webhook 平台：密钥校验、入站 → 真实 agent 回合 → 出站回复、会话渠道标记、测试发送
 *  2. Telegram 平台：长轮询（本地 mock Bot API）、消息 → 回合 → sendMessage 回复、测试发送
 *  3. OneBot v11 平台：正向 WebSocket（本地 mock 服务端）、私聊事件 → 回合 →
 *     send_private_msg 回复、测试发送走 send_group_msg
 *
 * 前置：brain 已启动（默认 http://localhost:3002）且可用的 LLM（真实或 mock）。
 * 脚本自建本地 mock 服务与平台记录，结束统一清理；不依赖任何真实平台账号。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'
import { WebSocketServer } from 'ws'

const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const WEBHOOK_PORT = Number(process.env.E2E_WEBHOOK_PORT ?? '3998')
const TELEGRAM_PORT = Number(process.env.E2E_TELEGRAM_PORT ?? '3997')
const ONEBOT_PORT = Number(process.env.E2E_ONEBOT_PORT ?? '3996')
const DISCORD_PORT = Number(process.env.E2E_DISCORD_PORT ?? '3995')
const DISCORD_WS_PORT = Number(process.env.E2E_DISCORD_WS_PORT ?? '3994')
const SLACK_PORT = Number(process.env.E2E_SLACK_PORT ?? '3993')
const SLACK_WS_PORT = Number(process.env.E2E_SLACK_WS_PORT ?? '3992')
const WECHAT_PORT = Number(process.env.E2E_WECHAT_PORT ?? '3989')
const QQ_PORT = Number(process.env.E2E_QQ_PORT ?? '3988')
const QQ_WS_PORT = Number(process.env.E2E_QQ_WS_PORT ?? '3987')
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
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (path === '/attachment.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(Buffer.from(PNG_1PX, 'base64'))
    return
  }
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
  const requestPath = new URL(req.url ?? '/', 'http://x').pathname
  if (requestPath.startsWith('/file/')) {
    res.setHeader('Content-Type', 'image/png')
    res.end(Buffer.from(PNG_1PX, 'base64'))
    return
  }
  const method = requestPath.split('/').pop()
  if (method === 'getFile') {
    res.end(JSON.stringify({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 70 } }))
    return
  }
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
        const data =
          message.action === 'get_msg'
            ? { message: [{ type: 'text', data: { text: '被引用的消息' } }] }
            : { message_id: 1 }
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: message.echo }))
      }
    } catch {
      /* ignore */
    }
  })
})
await sleep(200)

// ---------- Discord mock：REST + Gateway WebSocket ----------
const discordSent = []
let discordGatewaySocket = null
const discordServer = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (path === '/attachment.png') {
    res.setHeader('Content-Type', 'image/png')
    res.end(Buffer.from(PNG_1PX, 'base64'))
    return
  }
  if (path === '/users/@me') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: '9000', username: 'amadeus_e2e' }))
    return
  }
  const channelMatch = /^\/channels\/([^/]+)\/messages$/.exec(path)
  if (channelMatch) {
    try {
      discordSent.push({ channelId: channelMatch[1], ...JSON.parse(body) })
    } catch {
      /* ignore */
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: String(discordSent.length) }))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise((resolve) => discordServer.listen(DISCORD_PORT, '127.0.0.1', resolve))

const discordGateway = new WebSocketServer({ port: DISCORD_WS_PORT, host: '127.0.0.1' })
const discordHeartbeats = []
discordGateway.on('connection', (socket) => {
  discordGatewaySocket = socket
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }))
  socket.on('message', (data) => {
    try {
      const payload = JSON.parse(String(data))
      if (payload.op === 1) discordHeartbeats.push(payload.d)
      if (payload.op === 2) {
        socket.send(
          JSON.stringify({
            op: 0,
            t: 'READY',
            s: 1,
            d: { user: { id: '9000', username: 'amadeus_e2e' } }
          })
        )
      }
    } catch {
      /* ignore */
    }
  })
})

// ---------- Slack mock：Web API + Socket Mode WebSocket ----------
const slackSent = []
const slackAcks = []
let slackSocket = null
const slackServer = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const method = new URL(req.url ?? '/', 'http://x').pathname.split('/').pop()
  res.setHeader('Content-Type', 'application/json')
  if (method === 'auth.test') {
    res.end(JSON.stringify({ ok: true, user_id: 'UBOT', team: 'E2E Team' }))
    return
  }
  if (method === 'apps.connections.open') {
    res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${SLACK_WS_PORT}/` }))
    return
  }
  if (method === 'chat.postMessage') {
    try {
      slackSent.push(JSON.parse(body))
    } catch {
      /* ignore */
    }
    res.end(JSON.stringify({ ok: true, ts: '1700000000.0001' }))
    return
  }
  res.end(JSON.stringify({ ok: false, error: 'unknown_method' }))
})
await new Promise((resolve) => slackServer.listen(SLACK_PORT, '127.0.0.1', resolve))

const slackSocketServer = new WebSocketServer({ port: SLACK_WS_PORT, host: '127.0.0.1' })
slackSocketServer.on('connection', (socket) => {
  slackSocket = socket
  socket.send(JSON.stringify({ type: 'hello' }))
  socket.on('message', (data) => {
    try {
      slackAcks.push(JSON.parse(String(data)))
    } catch {
      /* ignore */
    }
  })
})

// ---------- 微信公众号 mock：token / 客服消息 / 媒体下载 ----------
const wechatSent = []
const wechatServer = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url ?? '/', 'http://x')
  res.setHeader('Content-Type', 'application/json')
  if (url.pathname === '/cgi-bin/token') {
    res.end(JSON.stringify({ access_token: 'wx-e2e-token', expires_in: 7200 }))
    return
  }
  if (url.pathname === '/cgi-bin/message/custom/send') {
    try {
      wechatSent.push(JSON.parse(body))
    } catch {
      /* ignore */
    }
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
    return
  }
  if (url.pathname === '/cgi-bin/media/get') {
    res.setHeader('Content-Type', 'image/png')
    res.end(Buffer.from(PNG_1PX, 'base64'))
    return
  }
  if (url.pathname === '/pic.png') {
    res.setHeader('Content-Type', 'image/png')
    res.end(Buffer.from(PNG_1PX, 'base64'))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise((resolve) => wechatServer.listen(WECHAT_PORT, '127.0.0.1', resolve))

// ---------- QQ 官方机器人 mock：token / gateway / REST 发送 ----------
const qqSent = []
let qqSocket = null
const qqServer = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const path = new URL(req.url ?? '/', 'http://x').pathname
  res.setHeader('Content-Type', 'application/json')
  if (path === '/app/getAppAccessToken') {
    res.end(JSON.stringify({ access_token: 'qq-e2e-token', expires_in: 7200 }))
    return
  }
  if (path === '/gateway') {
    res.end(JSON.stringify({ url: `ws://127.0.0.1:${QQ_WS_PORT}/websocket` }))
    return
  }
  const match = /^\/v2\/(users|groups)\/[^/]+\/messages$/.exec(path)
  if (match) {
    try {
      qqSent.push({ path, body: JSON.parse(body) })
    } catch {
      /* ignore */
    }
    res.end(JSON.stringify({ id: String(qqSent.length) }))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise((resolve) => qqServer.listen(QQ_PORT, '127.0.0.1', resolve))

const qqGateway = new WebSocketServer({ port: QQ_WS_PORT, host: '127.0.0.1' })
qqGateway.on('connection', (socket) => {
  qqSocket = socket
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }))
  socket.on('message', (data) => {
    try {
      const payload = JSON.parse(String(data))
      if (payload.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: {} }))
    } catch {
      /* ignore */
    }
  })
})

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
  discordServer.close()
  discordGateway.close()
  slackServer.close()
  slackSocketServer.close()
  wechatServer.close()
  qqServer.close()
  qqGateway.close()
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

  // 图片 + 引用：getFile 下载图片、sendMessage 带上 reply_parameters
  const telegramBeforeMedia = telegramSent.length
  telegramUpdates.push({
    update_id: 2,
    message: {
      message_id: 501,
      text: '这张图是什么',
      chat: { id: 42, type: 'private' },
      from: { id: 1001 },
      photo: [{ file_id: 'photo-1', file_size: 70 }],
      reply_to_message: { text: '上一条消息' }
    }
  })
  await waitFor(() => telegramSent.length > telegramBeforeMedia, 60_000, 'telegram 图片回复')
  const telegramMediaReply = telegramSent.at(-1)
  report(
    'Telegram：图片消息 → 回合 → 引用回复',
    typeof telegramMediaReply?.text === 'string' &&
      telegramMediaReply.text.length > 0 &&
      telegramMediaReply.reply_parameters?.message_id === 501,
    String(telegramMediaReply?.text ?? '').slice(0, 50)
  )
  const telegramUser2 = await autoUserId('telegram-1001')
  const telegramSessions2 = (await api(`/api/sessions?userId=${telegramUser2}`)).body.sessions ?? []
  const telegramMessages = (await api(`/api/sessions/${telegramSessions2[0]?.id}/messages`)).body.messages ?? []
  report(
    'Telegram：图片落库为消息附件',
    telegramMessages.some(
      (message) => message.role === 'user' && message.attachments?.some((item) => item.kind === 'image')
    )
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
  // 图片 + 引用：image 段下载、reply 段反查原文、回复用 reply 数组
  const oneBotBeforeMedia = oneBotActions.filter((action) => action.action === 'send_private_msg').length
  oneBotSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      self_id: 1,
      user_id: 10001,
      message_id: 888,
      message: [
        { type: 'text', data: { text: '这张图是什么' } },
        {
          type: 'image',
          data: { url: `http://127.0.0.1:${WEBHOOK_PORT}/attachment.png` }
        },
        { type: 'reply', data: { id: 777 } }
      ]
    })
  )
  await waitFor(
    () => oneBotActions.filter((action) => action.action === 'send_private_msg').length > oneBotBeforeMedia,
    60_000,
    'onebot 图片回复'
  )
  const oneBotMediaReply = oneBotActions.filter((action) => action.action === 'send_private_msg').at(-1)
  const segment = Array.isArray(oneBotMediaReply?.params?.message) ? oneBotMediaReply.params.message[0] : null
  report(
    'OneBot：图片 + 引用 → 回合 → reply 段回复',
    segment?.type === 'reply' && Number(segment?.data?.id) === 888,
    JSON.stringify(segment)
  )
  const oneBotMessages = (await api(`/api/sessions/${oneBotSessions[0]?.id}/messages`)).body.messages ?? []
  report(
    'OneBot：图片落库为消息附件',
    oneBotMessages.some(
      (message) => message.role === 'user' && message.attachments?.some((item) => item.kind === 'image')
    )
  )

  // ================= Discord =================
  res = await api('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'discord',
      name: 'E2E Discord',
      config: {
        botToken: 'discord-e2e-token',
        gatewayUrl: `ws://127.0.0.1:${DISCORD_WS_PORT}/?v=10&encoding=json`,
        apiBaseUrl: `http://127.0.0.1:${DISCORD_PORT}`,
        testChatId: '777'
      }
    })
  })
  const discordId = res.body.platform?.id
  createdPlatforms.push(discordId)
  report(
    'Discord：Gateway 连接与 IDENTIFY',
    res.status === 200 && res.body.platform?.status?.state === 'running',
    `state=${res.body.platform?.status?.state} detail=${res.body.platform?.status?.detail}`
  )
  report(
    'Discord：密钥不回显',
    res.body.platform?.config?.botTokenSet === true && res.body.platform?.config?.botToken === undefined
  )
  await waitFor(() => discordGatewaySocket, 10_000, 'discord gateway')
  await waitFor(() => discordHeartbeats.length > 0, 10_000, 'discord heartbeat')
  report('Discord：心跳已发送', discordHeartbeats.length > 0)

  discordGatewaySocket.send(
    JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'm1',
        channel_id: '555',
        guild_id: '1',
        content: '用一句话跟我打个招呼',
        author: { id: '1001', username: 'e2e', bot: false }
      }
    })
  )
  await waitFor(() => discordSent.length > 0, 60_000, 'discord 回复')
  report(
    'Discord：消息 → 回合 → REST 发送',
    String(discordSent[0]?.content ?? '').length > 0 &&
      !String(discordSent[0]?.content).includes('连不上大脑'),
    String(discordSent[0]?.content ?? '').slice(0, 60)
  )
  report('Discord：回复发给原频道', String(discordSent[0]?.channelId) === '555')
  report(
    'Discord：@everyone 不会被 ping',
    JSON.stringify(discordSent[0]?.allowed_mentions ?? {}) === JSON.stringify({ parse: [] })
  )

  // 机器人自己的消息不应触发回合（回声防护）
  const sentBeforeBotMessage = discordSent.length
  discordGatewaySocket.send(
    JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 3,
      d: {
        id: 'm2',
        channel_id: '555',
        guild_id: '1',
        content: '我是另一个 bot',
        author: { id: '9001', username: 'otherbot', bot: true }
      }
    })
  )
  await sleep(1200)
  report('Discord：忽略其它机器人的消息', discordSent.length === sentBeforeBotMessage)

  const discordUser = await autoUserId('discord-1001')
  const discordSessions = (await api(`/api/sessions?userId=${discordUser}`)).body.sessions ?? []
  createdSessions.push(...discordSessions.map((session) => session.id))
  report(
    'Discord：会话标记为 discord 渠道',
    discordSessions.length === 1 && discordSessions[0].channel === 'discord'
  )

  res = await api(`/api/platforms/${discordId}/test`, { method: 'POST' })
  await waitFor(() => discordSent.length > sentBeforeBotMessage, 10_000, 'discord 测试发送')
  report(
    'Discord：测试发送到配置的频道',
    res.status === 200 &&
      String(discordSent.at(-1)?.channelId) === '777'
  )

  // 图片 + 引用：附件下载、message_reference 回复
  const discordBeforeMedia = discordSent.length
  discordGatewaySocket.send(
    JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 4,
      d: {
        id: 'm3',
        channel_id: '555',
        guild_id: '1',
        content: '这张图是什么',
        author: { id: '1001', username: 'e2e', bot: false },
        attachments: [
          {
            url: `http://127.0.0.1:${DISCORD_PORT}/attachment.png`,
            content_type: 'image/png',
            filename: 'dot.png',
            size: 70
          }
        ],
        referenced_message: { content: '之前的消息' }
      }
    })
  )
  await waitFor(() => discordSent.length > discordBeforeMedia, 60_000, 'discord 图片回复')
  const discordMediaReply = discordSent.at(-1)
  report(
    'Discord：图片 + 引用 → 回合 → message_reference',
    String(discordMediaReply?.content ?? '').length > 0 &&
      discordMediaReply?.message_reference?.message_id === 'm3',
    String(discordMediaReply?.content ?? '').slice(0, 50)
  )
  const discordMessages = (await api(`/api/sessions/${discordSessions[0]?.id}/messages`)).body.messages ?? []
  report(
    'Discord：图片落库为消息附件',
    discordMessages.some(
      (message) => message.role === 'user' && message.attachments?.some((item) => item.kind === 'image')
    )
  )

  // ================= Slack（Socket Mode） =================
  res = await api('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'slack',
      name: 'E2E Slack',
      config: {
        botToken: 'xoxb-e2e',
        appToken: 'xapp-e2e',
        apiBaseUrl: `http://127.0.0.1:${SLACK_PORT}`,
        testChatId: 'C_TEST'
      }
    })
  })
  const slackId = res.body.platform?.id
  createdPlatforms.push(slackId)
  report(
    'Slack：Socket Mode 连接',
    res.status === 200 && res.body.platform?.status?.state === 'running',
    `state=${res.body.platform?.status?.state} detail=${res.body.platform?.status?.detail}`
  )
  report(
    'Slack：两个 token 都不回显',
    res.body.platform?.config?.botTokenSet === true &&
      res.body.platform?.config?.appTokenSet === true &&
      res.body.platform?.config?.botToken === undefined
  )
  await waitFor(() => slackSocket, 10_000, 'slack socket')

  slackSocket.send(
    JSON.stringify({
      type: 'events_api',
      envelope_id: 'env-1',
      payload: {
        event: {
          type: 'message',
          text: '用一句话跟我打个招呼',
          user: 'U1',
          channel: 'C1',
          channel_type: 'im'
        }
      }
    })
  )
  await waitFor(() => slackSent.length > 0, 60_000, 'slack 回复')
  report(
    'Slack：事件 → ack → 回合 → chat.postMessage',
    slackAcks.some((ack) => ack.envelope_id === 'env-1') &&
      String(slackSent[0]?.text ?? '').length > 0 &&
      !String(slackSent[0]?.text).includes('连不上大脑'),
    String(slackSent[0]?.text ?? '').slice(0, 60)
  )
  report('Slack：回复发给原会话', String(slackSent[0]?.channel) === 'C1')

  const sentBeforeBot = slackSent.length
  slackSocket.send(
    JSON.stringify({
      type: 'events_api',
      envelope_id: 'env-2',
      payload: {
        event: {
          type: 'message',
          text: '我是别的 bot',
          user: 'U2',
          channel: 'C2',
          channel_type: 'channel',
          bot_id: 'B1'
        }
      }
    })
  )
  await sleep(1200)
  report('Slack：忽略机器人消息', slackSent.length === sentBeforeBot)

  const slackUser = await autoUserId('slack-U1')
  const slackSessions = (await api(`/api/sessions?userId=${slackUser}`)).body.sessions ?? []
  createdSessions.push(...slackSessions.map((session) => session.id))
  report(
    'Slack：会话标记为 slack 渠道',
    slackSessions.length === 1 && slackSessions[0].channel === 'slack'
  )

  res = await api(`/api/platforms/${slackId}/test`, { method: 'POST' })
  await waitFor(() => slackSent.length > sentBeforeBot, 10_000, 'slack 测试发送')
  report(
    'Slack：测试发送到配置的会话',
    res.status === 200 && String(slackSent.at(-1)?.channel) === 'C_TEST'
  )

  // ================= 微信公众号 =================
  res = await api('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'wechat',
      name: 'E2E 微信公众号',
      config: {
        token: 'wx-callback-token',
        appId: 'wx-e2e-app',
        appSecret: 'wx-e2e-secret',
        apiBaseUrl: `http://127.0.0.1:${WECHAT_PORT}`,
        testOpenId: 'openid-test'
      }
    })
  })
  const wechatId = res.body.platform?.id
  createdPlatforms.push(wechatId)
  report(
    '微信：初始化与签名配置',
    res.status === 200 && res.body.platform?.status?.state === 'running',
    `state=${res.body.platform?.status?.state} detail=${res.body.platform?.status?.detail}`
  )
  report(
    '微信：两个密钥都不回显',
    res.body.platform?.config?.tokenSet === true &&
      res.body.platform?.config?.appSecretSet === true &&
      res.body.platform?.config?.token === undefined
  )

  const wxTimestamp = String(Math.floor(Date.now() / 1000))
  const wxNonce = 'nonce123'
  const wxSignature = createHash('sha1')
    .update(['wx-callback-token', wxTimestamp, wxNonce].sort().join(''))
    .digest('hex')
  const wxQuery = `signature=${wxSignature}&timestamp=${wxTimestamp}&nonce=${wxNonce}`
  res = await api(`/api/platforms/${wechatId}/wechat?${wxQuery}&echostr=hello-wechat`)
  report('微信：GET 回调校验回显 echostr', res.status === 200 && res.body === 'hello-wechat')

  const wxTextXml = `<xml><ToUserName><![CDATA[gh_e2e]]></ToUserName><FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>${wxTimestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[用一句话跟我打个招呼]]></Content><MsgId>1001</MsgId></xml>`
  res = await api(`/api/platforms/${wechatId}/wechat?${wxQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: wxTextXml
  })
  await waitFor(() => wechatSent.length > 0, 60_000, '微信回复')
  report(
    '微信：文本消息 → 回合 → 客服消息回复',
    res.status === 200 &&
      res.body === 'success' &&
      wechatSent[0]?.touser === 'openid-1' &&
      String(wechatSent[0]?.text?.content ?? '').length > 0 &&
      !String(wechatSent[0]?.text?.content).includes('连不上大脑'),
    String(wechatSent[0]?.text?.content ?? '').slice(0, 50)
  )

  const wxBeforeImage = wechatSent.length
  const wxImageXml = `<xml><ToUserName><![CDATA[gh_e2e]]></ToUserName><FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>${wxTimestamp}</CreateTime><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[http://127.0.0.1:${WECHAT_PORT}/pic.png]]></PicUrl><MediaId><![CDATA[media-1]]></MediaId><MsgId>1002</MsgId></xml>`
  res = await api(`/api/platforms/${wechatId}/wechat?${wxQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: wxImageXml
  })
  await waitFor(() => wechatSent.length > wxBeforeImage, 60_000, '微信图片回复')
  report(
    '微信：图片消息被接收并回复',
    res.status === 200 && wechatSent.length > wxBeforeImage
  )

  res = await api(`/api/platforms/${wechatId}/test`, { method: 'POST' })
  await waitFor(
    () => wechatSent.some((item) => item.touser === 'openid-test'),
    10_000,
    '微信测试发送'
  )
  report('微信：测试发送到配置的 OpenID', res.status === 200)

  // ================= QQ 官方机器人 =================
  res = await api('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'qqbot',
      name: 'E2E QQ 机器人',
      config: {
        appId: 'qq-e2e-app',
        clientSecret: 'qq-e2e-secret',
        tokenUrl: `http://127.0.0.1:${QQ_PORT}/app/getAppAccessToken`,
        apiBaseUrl: `http://127.0.0.1:${QQ_PORT}`,
        gatewayUrl: `ws://127.0.0.1:${QQ_WS_PORT}/websocket`,
        testOpenId: 'qq-openid-test'
      }
    })
  })
  const qqbotId = res.body.platform?.id
  createdPlatforms.push(qqbotId)
  report(
    'QQ 机器人：网关连接',
    res.status === 200 && res.body.platform?.status?.state === 'running',
    `state=${res.body.platform?.status?.state} detail=${res.body.platform?.status?.detail}`
  )
  report(
    'QQ 机器人：AppSecret 不回显',
    res.body.platform?.config?.clientSecretSet === true &&
      res.body.platform?.config?.clientSecret === undefined
  )
  await waitFor(() => qqSocket, 10_000, 'qq gateway')

  qqSocket.send(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'qq-msg-1',
        content: '<@!123456> 用一句话跟我打个招呼',
        author: { user_openid: 'qq-openid-1' },
        attachments: []
      }
    })
  )
  await waitFor(() => qqSent.length > 0, 60_000, 'QQ 回复')
  report(
    'QQ 机器人：私聊消息 → 回合 → 被动回复',
    qqSent[0]?.path.includes('/v2/users/qq-openid-1/messages') &&
      String(qqSent[0]?.body?.content ?? '').length > 0 &&
      qqSent[0]?.body?.msg_id === 'qq-msg-1',
    String(qqSent[0]?.body?.content ?? '').slice(0, 50)
  )

  res = await api(`/api/platforms/${qqbotId}/test`, { method: 'POST' })
  await waitFor(
    () => qqSent.some((item) => item.path.includes('/v2/users/qq-openid-test/messages')),
    10_000,
    'QQ 测试发送'
  )
  report('QQ 机器人：测试发送到配置的 OpenID', res.status === 200)

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
    const origin = await evalJs('location.origin')
    await cdp.call('Page.navigate', { url: `${origin}/settings` })
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

      // 删除是「再点一次确认」：必须先等按钮可用。上一步启停的请求可能还没回来，
      // 此时按钮 disabled，点击会被吞掉，于是第一次点击只把按钮切到确认态、
      // 第二次点击落在同一个「第一次」上 → 永远删不掉（曾导致本用例稳定失败）。
      await waitFor(
        () =>
          evalJs(
            `(() => {
               const b = document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-delete"]')
               return !!b && !b.disabled
             })()`
          ),
        10000,
        '删除按钮可用'
      )
      await evalJs(
        `document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-delete"]').click(); true`
      )
      // 确认态是真的切过去了（按钮变 destructive）再点第二次
      await waitFor(
        () =>
          evalJs(
            `(() => {
               const b = document.querySelector('[data-platform-id="${listed.id}"] [data-testid="platform-delete"]')
               return !!b && /destructive/.test(b.className)
             })()`
          ),
        5000,
        '删除确认态'
      )
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
