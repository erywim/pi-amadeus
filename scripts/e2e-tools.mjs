/**
 * 工具调用 E2E（brain 直连 HTTP SSE，无 CDP）：
 *  A 计算器：LLM 调用 calculate 工具 → tool_start/tool_end 成功 + 回复含 96
 *  B 天气：weather 工具 → tool_start/tool_end 成功 + done
 *  C bash 批准：tool_confirm → POST approved:true → tool_end 成功含 hello-amadeus
 *  D bash 拒绝：tool_confirm → approved:false → tool_end isError + deniedReason=user_denied
 *  G 高危拦截：format C: → 断言无 tool_confirm（拦截先于确认）→ deniedReason=blocked
 *  E 开关关闭：tools.enabled=false → 零 tool_* 事件 + done；恢复 true
 *  F 飞书：webhook 计算器请求 → 会话落库消息含 96（feishu 无 bash 工具）
 * 前置：brain 服务运行中（feishu 场景需 FEISHU_ENABLED）
 */
import { setTimeout as sleep } from 'node:timers/promises'

const BRAIN = 'http://localhost:3002'
const TURN_TIMEOUT = 180_000
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function jsonFetch(path, init) {
  const res = await fetch(`${BRAIN}${path}`, init)
  return { res, json: await res.json().catch(() => null) }
}

/**
 * 发起一个文本回合，读完整个 SSE 流。
 * onToolConfirm：收到 tool_confirm 时的回调（可在此 POST 回执；服务端会等待回执才继续）。
 * 返回 { events, full }（full = 全部 delta 拼接）。
 */
async function runChatTurn({ userId, sessionId, content, onToolConfirm }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT)
  try {
    const res = await fetch(`${BRAIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionId, content }),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`chat HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const events = []
    let full = ''
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        const evt = JSON.parse(payload)
        events.push(evt)
        if (evt.type === 'delta') full += evt.delta
        if (evt.type === 'tool_confirm' && onToolConfirm) await onToolConfirm(evt)
      }
    }
    return { events, full }
  } finally {
    clearTimeout(timer)
  }
}

function toolEvents(events, name) {
  const evts = events.filter((e) => e.type.startsWith('tool_'))
  return name ? evts.filter((e) => e.toolName === name) : evts
}

async function approveConfirm(evt) {
  const { res } = await jsonFetch('/api/tool-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId: evt.turnId, toolCallId: evt.toolCallId, approved: true })
  })
  if (!res.ok) throw new Error(`tool-confirm 批准失败 HTTP ${res.status}`)
}

async function denyConfirm(evt) {
  const { res } = await jsonFetch('/api/tool-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId: evt.turnId, toolCallId: evt.toolCallId, approved: false })
  })
  if (!res.ok) throw new Error(`tool-confirm 拒绝失败 HTTP ${res.status}`)
}

/**
 * 发送提示直到某工具被调用（模型行为有抖动：偶尔用文字敷衍而不调工具）。
 * prompts 依次升级语气；全部耗尽仍无工具调用时返回最后一次结果。
 */
async function runTurnUntilTool({ userId, sessionId, prompts, toolName, onToolConfirm }) {
  let result = null
  for (const content of prompts) {
    result = await runChatTurn({ userId, sessionId, content, onToolConfirm })
    const starts = result.events.filter((e) => e.type === 'tool_start')
    if (starts.length > 0 && (!toolName || starts.some((e) => e.toolName === toolName))) return result
  }
  return result
}

/** 强调工具调用的重试提示尾部 */
function insist(content) {
  return `${content}。请务必调用对应的工具来执行，不要用文字模拟结果`
}

// ---------- 准备：独立用户 + 会话 ----------

const suffix = Date.now()
const { res: uidRes, json: uidJson } = await jsonFetch('/api/users/resolve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: `tool-e2e-${suffix}` })
})
if (!uidRes.ok) {
  console.error('用户建档失败', uidJson)
  process.exit(1)
}
const userId = uidJson.userId
// 会话是懒创建的（首条消息时由 chat 落行），直接取一个稳定的客户端会话 id
const sessionId = `tool-e2e-${suffix}`
console.log(`测试用户: ${userId}  会话: ${sessionId}`)

try {
  // ---------- A 计算器 ----------
  console.log('\n=== A 计算器工具 ===')
  const a = await runChatTurn({
    userId,
    sessionId,
    content: '请使用计算器工具计算 (3+5)*12 的结果'
  })
  const aStarts = toolEvents(a.events, 'calculate').filter((e) => e.type === 'tool_start')
  const aEnd = toolEvents(a.events, 'calculate').find((e) => e.type === 'tool_end')
  const aDone = a.events.some((e) => e.type === 'done')
  report('A1 tool_start(calculate)', aStarts.length > 0)
  report('A2 tool_end(calculate) 成功', !!aEnd && !aEnd.isError, JSON.stringify(aEnd?.result ?? '').slice(0, 80))
  report('A3 done 事件', aDone)
  report('A4 回复/工具结果含 96', a.full.includes('96') || JSON.stringify(aEnd?.result ?? '').includes('96'))

  // ---------- B 天气 ----------
  console.log('\n=== B 天气工具 ===')
  const b = await runChatTurn({ userId, sessionId, content: '请使用天气工具查一下北京今天的天气' })
  const bStart = toolEvents(b.events, 'weather').some((e) => e.type === 'tool_start')
  const bEnd = toolEvents(b.events, 'weather').find((e) => e.type === 'tool_end')
  report('B1 tool_start(weather)', bStart)
  report('B2 tool_end(weather) 成功', !!bEnd && !bEnd.isError, JSON.stringify(bEnd?.result ?? '').slice(0, 80))
  report('B3 done 事件', b.events.some((e) => e.type === 'done'))

  // ---------- C bash 批准 ----------
  console.log('\n=== C bash 命令（用户批准） ===')
  const c = await runTurnUntilTool({
    userId,
    sessionId,
    prompts: [
      '请使用终端命令工具运行命令 echo hello-amadeus',
      insist('请使用终端命令工具运行命令 echo hello-amadeus')
    ],
    toolName: 'bash',
    onToolConfirm: approveConfirm
  })
  const cConfirm = c.events.filter((e) => e.type === 'tool_confirm')
  const cEnd = toolEvents(c.events, 'bash').find((e) => e.type === 'tool_end')
  report('C1 tool_confirm 弹出', cConfirm.length > 0)
  report('C2 tool_end(bash) 成功且输出含 hello-amadeus',
    !!cEnd && !cEnd.isError && JSON.stringify(cEnd.result).includes('hello-amadeus'),
    JSON.stringify(cEnd?.result ?? '').slice(0, 100))
  report('C3 done 事件', c.events.some((e) => e.type === 'done'))

  // ---------- D bash 拒绝 ----------
  console.log('\n=== D bash 命令（用户拒绝） ===')
  const d = await runTurnUntilTool({
    userId,
    sessionId,
    prompts: [
      '请使用终端命令工具运行命令 echo secret-thing',
      insist('请使用终端命令工具运行命令 echo secret-thing')
    ],
    toolName: 'bash',
    onToolConfirm: denyConfirm
  })
  const dEnd = toolEvents(d.events, 'bash').find((e) => e.type === 'tool_end')
  report('D1 tool_end(bash) isError', !!dEnd && dEnd.isError)
  report('D2 deniedReason=user_denied', dEnd?.details?.deniedReason === 'user_denied', JSON.stringify(dEnd?.details))
  report('D3 助手仍完成回复（done）', d.events.some((e) => e.type === 'done'))

  // ---------- G 高危拦截 ----------
  // 用无害命令（echo）承载高危模式：模型会调用 bash，安全层拦截；
  // 即使策略失效，真实执行也只是打印文本，测试本身零风险
  console.log('\n=== G 高危命令拦截（echo shutdown /s /t 0） ===')
  const g = await runTurnUntilTool({
    userId,
    sessionId,
    prompts: [
      '请使用终端命令工具运行命令 echo shutdown /s /t 0',
      insist('请使用终端命令工具运行命令 echo shutdown /s /t 0')
    ],
    toolName: 'bash'
  })
  const gConfirms = g.events.filter((e) => e.type === 'tool_confirm')
  const gEnd = toolEvents(g.events, 'bash').find((e) => e.type === 'tool_end')
  report('G1 无 tool_confirm（拦截先于确认）', gConfirms.length === 0, `confirm 数=${gConfirms.length}`)
  report('G2 tool_end(bash) isError', !!gEnd && gEnd.isError)
  report('G3 deniedReason=blocked', gEnd?.details?.deniedReason === 'blocked', JSON.stringify(gEnd?.details))
  report('G4 助手仍完成回复（done）', g.events.some((e) => e.type === 'done'))

  // ---------- E 开关关闭 ----------
  console.log('\n=== E 工具开关关闭 ===')
  await jsonFetch(`/api/config/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { tools: { enabled: false } } })
  })
  const e = await runChatTurn({
    userId,
    sessionId,
    content: '请使用计算器工具计算 2+3'
  })
  const eToolEvents = toolEvents(e.events)
  report('E1 零 tool_* 事件（工具定义未下发）', eToolEvents.length === 0, `tool 事件数=${eToolEvents.length}`)
  report('E2 done 事件（纯文本回复）', e.events.some((ev) => ev.type === 'done') && e.full.length > 0)
  await jsonFetch(`/api/config/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { tools: { enabled: true } } })
  })
  report('E3 恢复 tools.enabled=true', true)

  // ---------- F 飞书 ----------
  console.log('\n=== F 飞书工具回合 ===')
  const openId = `ou_tool_${suffix}`
  const chatId = `oc_tool_${suffix}`
  const w0 = Date.now()
  const w = await jsonFetch('/api/feishu/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'im.message.receive_v1',
        message: {
          message_id: `om_tool_${suffix}`,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '请用计算器工具计算 12*8' })
        },
        sender: { sender_id: { open_id: openId }, sender_type: 'user' }
      }
    })
  })
  report('F1 webhook 快速 200', w.res.ok && Date.now() - w0 < 3000, `${Date.now() - w0}ms`)
  // 飞书异步回合：轮询会话消息出现含 96 的助手消息
  let fMsg = null
  const fStart = Date.now()
  while (Date.now() - fStart < TURN_TIMEOUT) {
    const msgs = (await jsonFetch(`/api/sessions/feishu-${chatId}/messages`)).json?.messages ?? []
    fMsg = [...msgs].reverse().find((m) => m.role === 'assistant')
    if (fMsg?.content.includes('96')) break
    await sleep(3000)
  }
  report('F2 飞书会话落库助手消息含 96', !!fMsg?.content.includes('96'), (fMsg?.content ?? '').slice(0, 100))
} catch (error) {
  console.error('执行失败：', error.message)
  report('异常中断', false, error.message)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) process.exitCode = 1
