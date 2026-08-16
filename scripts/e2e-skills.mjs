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

try {
  // 1. 列表
  console.log('=== 1. skill 列表 ===')
  const g0 = await jsonFetch('/api/skills')
  const haiku = g0.json?.skills?.find((s) => s.name === 'haiku-writer')
  report('GET /api/skills 含示例 haiku-writer（enabled）', g0.res.ok && !!haiku && haiku.enabled === true, JSON.stringify(g0.json?.skills?.map((s) => s.name)))
  report('返回目录路径', typeof g0.json?.dir === 'string' && g0.json.dir.length > 0)

  // 2. 启停
  console.log('=== 2. 启停切换 ===')
  const p1 = await jsonFetch('/api/skills/haiku-writer/enabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  })
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
  const events = await runChatTurn({ userId: uid, sessionId, content: '请用俳句写一首关于夏天的诗' })
  const start = events.find((e) => e.type === 'tool_start' && e.toolName === 'use_skill')
  const end = events.find((e) => e.type === 'tool_end' && e.toolName === 'use_skill')
  report('tool_start(use_skill)', !!start)
  report('tool_end(use_skill) 成功且返回 SKILL.md 内容', !!end && !end.isError && String(end.result).includes('haiku-writer'), String(end?.result ?? '').slice(0, 60))
  report('done 事件', events.some((e) => e.type === 'done'))
} catch (error) {
  console.error('执行失败：', error.message)
  report('异常中断', false, error.message)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) process.exitCode = 1
