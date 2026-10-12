/**
 * 飞书渠道 E2E（模拟 webhook 事件，不依赖真实飞书）：
 *  1. url_verification 握手回显 challenge
 *  2. p2p 消息 → 200 快速应答 + 异步回合 → 自动建档用户（feishu-<open_id>）、
 *     会话 feishu-<chat_id>（channel=feishu）落库、自动标题
 *  3. 绑定码：一次性测试用户 bind-code + 新 open_id 发送绑定码 → 后续消息路由到该用户会话列表
 *     （不再引用真实桌面用户 uuid；落库的测试会话结束时 DELETE）
 */
import { setTimeout as sleep } from 'node:timers/promises'

const BRAIN = 'http://localhost:3002'
const run = `feishu-e2e-${Date.now()}`
const OPEN_ID_A = `ou_fake_${run}`
const CHAT_ID_A = `oc_fake_${run}`
const OPEN_ID_B = `ou_fake_b_${run}`
const CHAT_ID_B = `oc_fake_b_${run}`
// 专用一次性测试用户：不再引用真实桌面用户 uuid，绑定码/飞书绑定只落在这个用户上
const TEST_USERNAME = `e2e-feishu-bot-${run}`
// 本测试落库过的会话（结束统一 DELETE，不留在真实会话库）
const createdSessionIds = [`feishu-${CHAT_ID_A}`, `feishu-${CHAT_ID_B}`]

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

/** DELETE 本测试落库的会话；清理失败仅告警，不掩盖原测试结果 */
async function cleanupSessions() {
  for (const id of createdSessionIds) {
    try {
      const res = await fetch(`${BRAIN}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) console.warn(`[e2e-feishu] 清理测试会话 ${id} 失败：HTTP ${res.status}`)
    } catch (error) {
      console.warn(`[e2e-feishu] 清理测试会话 ${id} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
}

// 信号兜底清理：Ctrl+C（SIGINT）/SIGTERM 时 try/finally 不会执行
let cleanupPromise = null
/** 收尾 + 信号兜底共用的一次性清理（多路触发只跑一次；失败仅告警，不掩盖原测试结果） */
function cleanupOnce() {
  cleanupPromise ??= cleanupSessions().catch((error) =>
    console.warn(`[e2e-feishu] 清理失败：${error instanceof Error ? error.message : error}`)
  )
  return cleanupPromise
}
let signalExitCode = null
/** 首次信号：清理后按信号码退出（SIGINT=130/SIGTERM=143）；清理中再次收到信号则立即退出，防清理卡死 */
function onSignal(code) {
  if (signalExitCode !== null) process.exit(code)
  signalExitCode = code
  void cleanupOnce().then(() => process.exit(code))
}
process.on('SIGINT', () => onSignal(130))
process.on('SIGTERM', () => onSignal(143))

try {
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

  console.log('=== 3. 绑定码 → 身份绑定 → 消息路由到绑定用户 ===')
  // 一次性测试用户（username 带明显测试标记）；绑定码生成与 feishu_open_id 都只落在它身上
  const testUserRes = await fetch(`${BRAIN}/api/users/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USERNAME })
  })
  const testUserId = (await testUserRes.json()).userId
  const bcRes = await fetch(`${BRAIN}/api/users/${testUserId}/bind-code`)
  const bindCode = (await bcRes.json()).bindCode
  report('获取绑定码（专用测试用户）', /^AMADEUS-\d{4}$/.test(bindCode ?? ''), bindCode)
  await postWebhook(p2pEvent(OPEN_ID_B, CHAT_ID_B, bindCode))
  await sleep(5000) // 绑定是异步的，稍等
  await postWebhook(p2pEvent(OPEN_ID_B, CHAT_ID_B, '绑定后测试消息'))
  const boundSession = await waitSessions(
    testUserId,
    (sessions) => sessions.find((s) => s.id === `feishu-${CHAT_ID_B}` && s.channel === 'feishu' && s.messageCount >= 2),
    90000,
    '绑定后消息路由到绑定用户会话列表'
  )
  report('绑定后回合路由到绑定用户（feishu-<chatB>）', !!boundSession, `messageCount=${boundSession?.messageCount}`)
} finally {
  // DELETE 本测试落库的会话（cleanupSessions 内部各步失败仅告警，不掩盖原测试结果）
  await cleanupOnce()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) process.exitCode = 1
