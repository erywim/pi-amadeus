/**
 * 知识库 / 自动化 / 会话增强 E2E（全部走后端真实链路）：
 *  1. 知识库：创建 → 导入文本 → TF-IDF 检索 → 真实模型带 search_knowledge 工具回答
 *  2. 知识库：URL 导入（本地 HTML，去标签）→ 删除文档后检索不再命中
 *  3. 自动化：创建 → 立即运行 → 轮询到 success → 结果落独立会话、指标落库
 *  4. 自动化：interval/daily/once 校验与下次触发时间，启停后 nextRunAt 语义
 *  5. 会话：置顶、正文搜索、编辑后重发（截断旧分支）、用量统计
 *
 * 前置：brain 已启动（默认 http://localhost:3002）且 LLM 可用。
 * 脚本自建用户与数据，结束统一清理，不触碰真实会话。
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'

const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const HTML_PORT = Number(process.env.E2E_HTML_PORT ?? '3991')
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
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(250)
  }
}

/** 消费 SSE 回合：返回正文、工具名、是否 done/error */
async function runTurn(path, body) {
  const res = await fetch(`${BRAIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`回合 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const tools = []
  let done = false
  let error = ''
  for (;;) {
    const { done: finished, value } = await reader.read()
    if (finished) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      const event = JSON.parse(payload)
      if (event.type === 'delta') text += event.delta
      else if (event.type === 'tool_start') tools.push(event.toolName)
      else if (event.type === 'done') done = true
      else if (event.type === 'error') error = event.message
    }
  }
  return { text, tools, done, error }
}

const stamp = Date.now()
const username = `e2e-ka-${stamp}`
/** 登录后写入，清理阶段按归属删除知识库 */
let ownerUserId = ''
const createdSessions = []
const createdBases = []
const createdAutomations = []
const createdProviders = []
const htmlServer = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><html><head><title>E2E</title>
    <style>body{color:red}</style><script>window.secret='不应进入知识库'</script></head>
    <body><h1>星港手册</h1><p>星港的对接频率是 7.25 GHz。</p><p>维护窗口在每周三凌晨。</p></body></html>`)
})
await new Promise((resolve) => htmlServer.listen(HTML_PORT, '127.0.0.1', resolve))

let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const id of createdAutomations) {
    await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdBases) {
    await api(
      `/api/knowledge/${encodeURIComponent(id)}?userId=${encodeURIComponent(ownerUserId)}`,
      { method: 'DELETE' }
    ).catch(() => {})
  }
  for (const id of createdSessions) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdProviders) {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  htmlServer.close()
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))
process.on('SIGTERM', () => void cleanup().then(() => process.exit(143)))

try {
  // ---------- 用户 ----------
  const login = await jsonApi('/api/users/login', 'POST', { username })
  const userId = login.body.userId
  ownerUserId = userId
  report('用户：创建测试身份', typeof userId === 'string' && userId.length > 0, username)

  // ================= 知识库 =================
  let res = await jsonApi('/api/knowledge', 'POST', {
    userId,
    name: `E2E 星尘计划 ${stamp}`,
    description: '自动化测试导入的知识库'
  })
  const kbId = res.body.base?.id
  createdBases.push(kbId)
  report('知识库：创建', res.status === 200 && Boolean(kbId))

  res = await jsonApi(`/api/knowledge/${kbId}/docs?userId=${userId}`, 'POST', {
    name: '星尘计划备忘',
    content:
      '星尘计划的内部代号是 ORANGE-42。项目负责人是桥田至。交付日期定在 2031 年 4 月 1 日。\n\n' +
      '项目周报：本周完成了轨道计算模块，下周开始联调。'
  })
  report(
    '知识库：粘贴导入并切块',
    res.status === 200 && res.body.doc?.chunks > 0 && res.body.doc?.chars > 0,
    `chunks=${res.body.doc?.chunks} chars=${res.body.doc?.chars}`
  )
  res = await api(
    `/api/knowledge/${kbId}/search?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent('星尘计划交付日期')}`
  )
  const hit = res.body.hits?.[0]
  report(
    '知识库：检索命中真实原文',
    res.status === 200 && Boolean(hit) && hit.content.includes('2031 年 4 月 1 日'),
    hit ? `score=${hit.score}` : 'no hit'
  )

  // 真实模型 + search_knowledge 工具
  res = await api(`/api/knowledge?userId=${userId}`)
  const totalsBefore = res.body.totals
  report(
    '知识库：列表统计与文档数一致',
    totalsBefore?.docs === 1 && totalsBefore?.chunks >= 1,
    `docs=${totalsBefore?.docs} chunks=${totalsBefore?.chunks}`
  )

  const sessionId = `e2e-ka-${stamp}-chat`
  createdSessions.push(sessionId)
  const turn = await runTurn('/api/chat', {
    userId,
    sessionId,
    content: '星尘计划的代号是什么？负责人是谁？交付日期呢？请先查知识库再回答。'
  })
  report('知识库：模型调用了 search_knowledge', turn.tools.includes('search_knowledge'), turn.tools.join(','))
  report(
    '知识库：回答引用了导入的原文',
    turn.done &&
      !turn.error &&
      turn.text.includes('ORANGE-42') &&
      turn.text.includes('桥田至'),
    turn.text.slice(0, 80)
  )

  // 第二个知识库：检索隔离
  res = await jsonApi('/api/knowledge', 'POST', { userId, name: `E2E 隔离库 ${stamp}` })
  const kb2 = res.body.base?.id
  createdBases.push(kb2)
  await jsonApi(`/api/knowledge/${kb2}/docs?userId=${userId}`, 'POST', {
    name: '无关资料',
    content: '这份资料只讨论咖啡豆的烘焙曲线，与星尘计划无关。'
  })
  res = await api(
    `/api/knowledge/${kbId}/search?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent('咖啡豆烘焙曲线')}`
  )
  report(
    '知识库：跨库检索互相隔离',
    (res.body.hits ?? []).every((item) => item.kbId === kbId)
  )

  // URL 导入
  res = await jsonApi(`/api/knowledge/${kb2}/import-url?userId=${userId}`, 'POST', {
    url: `http://127.0.0.1:${HTML_PORT}/handbook`
  })
  report('知识库：URL 导入成功', res.status === 200 && res.body.doc?.chunks > 0)
  const urlDocId = res.body.doc?.id
  res = await api(
    `/api/knowledge/${kb2}/search?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent('对接频率')}`
  )
  const urlHit = res.body.hits?.[0]
  report(
    '知识库：HTML 去标签后入库',
    Boolean(urlHit) &&
      urlHit.content.includes('7.25 GHz') &&
      !urlHit.content.includes('window.secret') &&
      !urlHit.content.includes('<'),
    urlHit?.content?.slice(0, 40)
  )

  // 删除文档后不再命中
  await api(`/api/knowledge/docs/${urlDocId}`, { method: 'DELETE' })
  res = await api(
    `/api/knowledge/${kb2}/search?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent('对接频率')}`
  )
  report('知识库：删除文档后检索不再命中', (res.body.hits ?? []).length === 0)

  // ================= 自动化 =================
  res = await jsonApi('/api/automations', 'POST', {
    userId,
    name: `E2E 自动任务 ${stamp}`,
    prompt: '只回复四个字：自动完成。不要调用任何工具。',
    schedule: 'interval',
    intervalMinutes: 30,
    enabled: false
  })
  const automationId = res.body.automation?.id
  createdAutomations.push(automationId)
  report(
    '自动化：创建（停用）不排期',
    res.status === 200 && res.body.automation?.enabled === false && res.body.automation?.nextRunAt === null
  )

  res = await jsonApi(`/api/automations/${automationId}/run`, 'POST')
  report('自动化：立即运行返回 202', res.status === 202)
  const finished = await waitFor(
    async () => {
      const list = await api(`/api/automations?userId=${userId}`)
      const item = list.body.automations?.find((row) => row.id === automationId)
      return item && (item.lastStatus === 'success' || item.lastStatus === 'error') ? item : null
    },
    120_000,
    '自动化运行结束'
  ).catch(() => null)
  report(
    '自动化：真实回合执行成功',
    finished?.lastStatus === 'success' && String(finished?.lastResult ?? '').length > 0,
    `${finished?.lastStatus} ${String(finished?.lastResult ?? '').slice(0, 40)} ${finished?.lastError ?? ''}`
  )

  res = await api(`/api/automations/${automationId}/messages`)
  report(
    '自动化：结果落在独立会话（用户 + 助手两条消息）',
    res.body.messages?.length === 2 &&
      res.body.messages[0].role === 'user' &&
      res.body.messages[1].role === 'assistant'
  )
  createdSessions.push(`automation-${automationId}`)

  // 调度语义
  res = await jsonApi('/api/automations', 'POST', {
    userId,
    name: `E2E 排期 ${stamp}`,
    prompt: '测试排期',
    schedule: 'interval',
    intervalMinutes: 5
  })
  const scheduledId = res.body.automation?.id
  createdAutomations.push(scheduledId)
  const nextRunAt = res.body.automation?.nextRunAt
  report(
    '自动化：启用后写入下次触发时间',
    typeof nextRunAt === 'number' && nextRunAt > Date.now() + 4 * 60_000
  )

  res = await jsonApi(`/api/automations/${scheduledId}`, 'PATCH', { enabled: false })
  report('自动化：停用后清空下次触发时间', res.body.automation?.nextRunAt === null)

  res = await jsonApi(`/api/automations/${scheduledId}`, 'PATCH', { enabled: true, intervalMinutes: 10 })
  const updatedNext = res.body.automation?.nextRunAt
  report(
    '自动化：改间隔后重算下次触发',
    typeof updatedNext === 'number' && updatedNext > Date.now() + 9 * 60_000
  )

  res = await jsonApi('/api/automations', 'POST', {
    userId,
    name: 'E2E 过去的一次性',
    prompt: '测试',
    schedule: 'once',
    runAt: Date.now() - 60_000
  })
  report('自动化：过去的一次性时间被拒绝', res.status === 400)

  res = await jsonApi('/api/automations', 'POST', {
    userId,
    name: 'E2E 过快间隔',
    prompt: '测试',
    schedule: 'interval',
    intervalMinutes: 1
  })
  report('自动化：小于 5 分钟的间隔被拒绝', res.status === 400)

  // ================= 模型服务故障转移 =================
  const envMap = readEnv(new URL('../services/brain/.env', import.meta.url))
  if (!envMap.LLM_API_KEY || !envMap.LLM_BASE_URL) {
    report('故障转移：跳过（services/brain/.env 没有真实 LLM 配置）', true, 'not run')
  } else {
    const bad = await jsonApi('/api/providers', 'POST', {
      name: `E2E 故障服务 ${stamp}`,
      baseUrl: 'http://127.0.0.1:9',
      model: 'bad-model',
      apiKey: 'not-a-real-key',
      priority: 1
    })
    const badId = bad.body.provider?.id
    createdProviders.push(badId)
    const good = await jsonApi('/api/providers', 'POST', {
      name: `E2E 真实服务 ${stamp}`,
      baseUrl: envMap.LLM_BASE_URL,
      model: envMap.AI_MODEL || 'deepseek-v4-pro',
      apiKey: envMap.LLM_API_KEY,
      priority: 2
    })
    const goodId = good.body.provider?.id
    createdProviders.push(goodId)
    await jsonApi(`/api/providers/${badId}/active`, 'PUT')

    const badSession = `e2e-failover-bad-${stamp}`
    const goodSession = `e2e-failover-good-${stamp}`
    createdSessions.push(badSession, goodSession)

    const failedTurn = await runTurn('/api/chat', {
      userId,
      sessionId: badSession,
      content: '这条一定失败'
    })
    report(
      '故障转移：激活服务不可用时回合报错（不伪装成功）',
      !failedTurn.done && Boolean(failedTurn.error),
      failedTurn.error.slice(0, 60)
    )

    let providers = await api('/api/providers')
    const badRow = providers.body.providers?.find((item) => item.id === badId)
    report('故障转移：失败服务进入冷却', badRow?.coolingDown === true)

    const goodTurn = await runTurn('/api/chat', {
      userId,
      sessionId: goodSession,
      content: '只回复：转移成功'
    })
    report(
      '故障转移：下一回合自动改用健康服务并成功',
      goodTurn.done && goodTurn.text.includes('转移成功'),
      goodTurn.text.slice(0, 40)
    )

    const stats = await api(`/api/stats?userId=${userId}&days=7`)
    const goodStats = stats.body.providers?.find((item) => item.name.startsWith('E2E 真实服务'))
    report(
      '故障转移：指标记录实际使用的服务',
      Boolean(goodStats) && goodStats.turns >= 1,
      goodStats ? `${goodStats.turns} turns / ${goodStats.tokens} tokens` : 'missing'
    )

    // 连通性测试失败同样进入冷却；成功则解除
    const badTest = await jsonApi(`/api/providers/${badId}/test`, 'POST')
    const goodTest = await jsonApi(`/api/providers/${goodId}/test`, 'POST')
    providers = await api('/api/providers')
    const afterTests = providers.body.providers ?? []
    report(
      '故障转移：连通性测试结果与冷却状态一致',
      badTest.body.ok === false &&
        goodTest.body.ok === true &&
        afterTests.find((item) => item.id === badId)?.coolingDown === true &&
        afterTests.find((item) => item.id === goodId)?.coolingDown === false
    )
  }

  // ================= 会话增强 =================
  res = await jsonApi(`/api/sessions/${sessionId}`, 'PATCH', { pinned: true, userId })
  report('会话：置顶成功', res.status === 200 && res.body.pinned === true)

  res = await api(`/api/sessions?userId=${userId}`)
  const pinnedFirst = res.body.sessions?.[0]
  report('会话：置顶会话排在列表最前', pinnedFirst?.id === sessionId && pinnedFirst?.pinned === true)

  res = await api(
    `/api/sessions/search?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent('桥田至')}`
  )
  report(
    '会话：正文搜索命中',
    (res.body.hits ?? []).length >= 1 &&
      res.body.hits.some((item) => item.sessionId === sessionId && item.snippet.includes('桥田至'))
  )

  res = await api(`/api/sessions/${sessionId}/messages`)
  const userMessage = res.body.messages?.find((message) => message.role === 'user')
  report('会话：消息列表可读', Boolean(userMessage))

  const edited = await runTurn('/api/chat/edit', {
    userId,
    sessionId,
    messageId: userMessage.id,
    content: '只回答项目负责人是谁，不要解释。'
  })
  report('会话：编辑后重发完成', edited.done && !edited.error, edited.text.slice(0, 40))
  res = await api(`/api/sessions/${sessionId}/messages`)
  report(
    '会话：编辑后旧分支被截断（只剩一问一答）',
    res.body.messages?.length === 2 &&
      res.body.messages[0].content === '只回答项目负责人是谁，不要解释。' &&
      res.body.messages[1].role === 'assistant'
  )

  res = await api(`/api/sessions/${sessionId}/usage`)
  report(
    '会话：用量来自真实回合指标',
    res.body.turns >= 2 && res.body.totalTokens > 0,
    `turns=${res.body.turns} tokens=${res.body.totalTokens}`
  )

  // 清理：取消置顶（会话随后删除）
  await api(`/api/sessions/${sessionId}`, { method: 'DELETE' })
} catch (error) {
  console.error('E2E 异常：', error)
  report('脚本执行完成', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanup()
}

/** 读取 .env：只用于故障转移用例创建「真实服务」，密钥不会打印 */
function readEnv(url) {
  try {
    const text = readFileSync(url, 'utf8')
    const map = {}
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) map[match[1]] = match[2]
    }
    return map
  } catch {
    return {}
  }
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
if (passed !== results.length) process.exitCode = 1
