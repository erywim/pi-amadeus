/**
 * skill 系统 E2E（brain 直连 HTTP，无 CDP）：
 *  1. GET /api/skills 列表（haiku-writer 示例在库）
 *  2. PUT 停用 → 列表 enabled=false；再启用 → enabled=true
 *  3. PUT 未知 skill → 404
 *  4. 对话触发 use_skill（启用状态下，俳句请求）→ tool_start/tool_end 成功 + done
 * 前置：brain 服务运行中（skills 目录含示例 skill）
 */
const BRAIN = 'http://localhost:3002'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function jsonFetch(path, init) {
  const res = await fetch(`${BRAIN}${path}`, init)
  return { res, json: await res.json().catch(() => null) }
}

async function runChatTurn({ userId, sessionId, content }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const res = await fetch(`${BRAIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionId, content }),
      signal: controller.signal
    })
    if (!res.ok || !res.body) throw new Error(`chat HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const events = []
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
        const p = line.slice(5).trim()
        if (!p || p === '[DONE]') continue
        events.push(JSON.parse(p))
      }
    }
    return events
  } finally {
    clearTimeout(timer)
  }
}

let originalEnabled = null // haiku-writer 原启停状态（finally 里还原成它，失败仅告警）
let toggled = false // 是否已对真实状态文件做过启停写入
let testSessionId = null // 第 4 步对话用的一次性会话，结束 DELETE

/** 还原 haiku-writer 为原启停状态（原本禁用就还原为禁用）；清理第 4 步的测试会话。失败仅告警 */
async function cleanup() {
  if (toggled && originalEnabled !== null) {
    try {
      const { res } = await jsonFetch('/api/skills/haiku-writer/enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: originalEnabled })
      })
      if (!res.ok) console.warn(`[e2e-skills] 还原 haiku-writer 启停状态失败：HTTP ${res.status}`)
    } catch (error) {
      console.warn(`[e2e-skills] 还原 haiku-writer 启停状态失败：${error instanceof Error ? error.message : error}`)
    }
  }
  if (testSessionId) {
    try {
      const res = await fetch(`${BRAIN}/api/sessions/${encodeURIComponent(testSessionId)}`, { method: 'DELETE' })
      if (!res.ok) console.warn(`[e2e-skills] 清理测试会话失败：HTTP ${res.status}`)
    } catch (error) {
      console.warn(`[e2e-skills] 清理测试会话失败：${error instanceof Error ? error.message : error}`)
    }
  }
}

// 信号兜底清理：Ctrl+C（SIGINT）/SIGTERM 时 try/finally 不会执行
let cleanupPromise = null
/** 收尾 + 信号兜底共用的一次性清理（多路触发只跑一次；失败仅告警，不掩盖原测试结果） */
function cleanupOnce() {
  cleanupPromise ??= cleanup().catch((error) =>
    console.warn(`[e2e-skills] 清理失败：${error instanceof Error ? error.message : error}`)
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
  // 1. 列表
  console.log('=== 1. skill 列表 ===')
  const g0 = await jsonFetch('/api/skills')
  const haiku = g0.json?.skills?.find((s) => s.name === 'haiku-writer')
  originalEnabled = typeof haiku?.enabled === 'boolean' ? haiku.enabled : null
  if (originalEnabled === null) console.warn('[e2e-skills] 未能读取 haiku-writer 原启停状态，结束时跳过一次还原')
  report('GET /api/skills 含示例 haiku-writer（enabled）', g0.res.ok && !!haiku && haiku.enabled === true, JSON.stringify(g0.json?.skills?.map((s) => s.name)))
  report('返回目录路径', typeof g0.json?.dir === 'string' && g0.json.dir.length > 0)

  // 2. 启停
  console.log('=== 2. 启停切换 ===')
  const p1 = await jsonFetch('/api/skills/haiku-writer/enabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  })
  if (p1.res.ok) toggled = true
  report('PUT 停用 200 且 enabled=false', p1.res.ok && p1.json?.skill?.enabled === false)
  const g1 = await jsonFetch('/api/skills')
  report('停用状态持久化（列表可见）', g1.json?.skills?.find((s) => s.name === 'haiku-writer')?.enabled === false)
  const p2 = await jsonFetch('/api/skills/haiku-writer/enabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  })
  report('PUT 重新启用 200 且 enabled=true', p2.res.ok && p2.json?.skill?.enabled === true)

  // 3. 未知 skill 404
  console.log('=== 3. 未知 skill ===')
  const p3 = await jsonFetch('/api/skills/not-exist/enabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  })
  report('PUT 未知 skill → 404', p3.res.status === 404)

  // 4. 对话触发 use_skill
  console.log('=== 4. use_skill 工具调用 ===')
  const uid = (await jsonFetch('/api/users/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `skill-e2e-${Date.now()}` })
  })).json.userId
  const sessionId = `skill-e2e-${Date.now()}`
  testSessionId = sessionId
  const events = await runChatTurn({ userId: uid, sessionId, content: '请用俳句写一首关于夏天的诗' })
  const start = events.find((e) => e.type === 'tool_start' && e.toolName === 'use_skill')
  const end = events.find((e) => e.type === 'tool_end' && e.toolName === 'use_skill')
  report('tool_start(use_skill)', !!start)
  report('tool_end(use_skill) 成功且返回 SKILL.md 内容', !!end && !end.isError && String(end.result).includes('haiku-writer'), String(end?.result ?? '').slice(0, 60))
  report('done 事件', events.some((e) => e.type === 'done'))
} catch (error) {
  console.error('执行失败：', error.message)
  report('异常中断', false, error.message)
} finally {
  // 还原 skill 启停态 + 清理测试会话（cleanup 内部各步失败仅告警，不掩盖原测试结果）
  await cleanupOnce()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) process.exitCode = 1
