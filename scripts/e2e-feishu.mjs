/**
 * 飞书渠道 E2E（模拟 webhook 事件，不依赖真实飞书）：
 *  1. url_verification 握手回显 challenge
 *  2. p2p 消息 → 200 快速应答 + 异步回合 → 自动建档用户（feishu-<open_id>）、
 *     会话 feishu-<chat_id>（channel=feishu）落库、自动标题
 *  3. 绑定码：桌面用户 bind-code + 新 open_id 发送绑定码 → 后续消息路由到桌面用户会话列表
 */
import { setTimeout as sleep } from 'node:timers/promises'

const BRAIN = 'http://localhost:3002'
const ELECTRON_USER = '33f8a269-b416-46e9-9b6a-07177a85a9a2'
const run = `feishu-e2e-${Date.now()}`
const OPEN_ID_A = `ou_fake_${run}`
const CHAT_ID_A = `oc_fake_${run}`
const OPEN_ID_B = `ou_fake_b_${run}`
const CHAT_ID_B = `oc_fake_b_${run}`

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function postWebhook(body) {
  const res = await fetch(`${BRAIN}/api/feishu/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function p2pEvent(openId, chatId, text) {
  return {
    type: 'event_callback',
    event: {
      type: 'im.message.receive_v1',
      message: {
        message_id: `om_fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        chat_id: chatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text })
      },
      sender: { sender_id: { open_id: openId }, sender_type: 'user' }
    }
  }
}

async function sessionsOf(userId) {
  const res = await fetch(`${BRAIN}/api/sessions?userId=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`sessions HTTP ${res.status}`)
  return (await res.json()).sessions
}

async function waitSessions(userId, predicate, timeoutMs = 90000, label = '') {
  const start = Date.now()
  for (;;) {
    const sessions = await sessionsOf(userId)
    const hit = predicate(sessions)
    if (hit) return hit
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时: ${label}；当前会话: ${sessions.map((s) => `${s.id}#${s.channel}`).join(', ')}`)
    }
    await sleep(2000)
  }
}

console.log('=== 1. url_verification 握手 ===')
const challenge = `challenge-${run}`
const v = await postWebhook({ type: 'url_verification', challenge })
report('challenge 回显', v.status === 200 && v.json?.challenge === challenge, JSON.stringify(v.json))

console.log('=== 2. p2p 消息 → 异步回合落库 ===')
const t0 = Date.now()
const r2 = await postWebhook(p2pEvent(OPEN_ID_A, CHAT_ID_A, '今天心情如何？'))
report('webhook 快速 200（不阻塞）', r2.status === 200 && Date.now() - t0 < 3000, `${Date.now() - t0}ms`)
const uidRes = await fetch(`${BRAIN}/api/users/resolve`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: `feishu-${OPEN_ID_A}` })
})
const feishuUserId = (await uidRes.json()).userId
report('自动建档用户（feishu-<open_id>）', typeof feishuUserId === 'string', feishuUserId)
const sessionA = await waitSessions(
  feishuUserId,
  (sessions) =>
    sessions.find(
      (s) => s.id === `feishu-${CHAT_ID_A}` && s.channel === 'feishu' && s.messageCount >= 2 && s.title
    ),
  90000,
  '会话 feishu-' + CHAT_ID_A + ' 落库（≥2 消息 + 自动标题）'
)
report('会话落库 channel=feishu + 用户/助手消息 + 自动标题', !!sessionA, `messageCount=${sessionA?.messageCount}, title=${sessionA?.title}`)

console.log('=== 3. 绑定码 → 身份绑定 → 消息路由到桌面用户 ===')
const bcRes = await fetch(`${BRAIN}/api/users/${ELECTRON_USER}/bind-code`)
const bindCode = (await bcRes.json()).bindCode
report('获取桌面用户绑定码', /^AMADEUS-\d{4}$/.test(bindCode ?? ''), bindCode)
await postWebhook(p2pEvent(OPEN_ID_B, CHAT_ID_B, bindCode))
await sleep(5000) // 绑定是异步的，稍等
await postWebhook(p2pEvent(OPEN_ID_B, CHAT_ID_B, '绑定后测试消息'))
const boundSession = await waitSessions(
  ELECTRON_USER,
  (sessions) => sessions.find((s) => s.id === `feishu-${CHAT_ID_B}` && s.channel === 'feishu' && s.messageCount >= 2),
  90000,
  '绑定后消息路由到桌面用户会话列表'
)
report('绑定后回合路由到桌面用户（feishu-<chatB>）', !!boundSession, `messageCount=${boundSession?.messageCount}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) process.exitCode = 1
