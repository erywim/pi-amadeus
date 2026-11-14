/**
 * 自动化事件触发 + 模型路由组/配额 + 主动问候（大脑真实链路）：
 *  1. Webhook 自动化：密钥校验 → 202 → 真实回合 → lastTrigger/结果
 *  2. 文件变化自动化：fs.watch + 防抖 → 写入文件 → 真实回合
 *  3. 定时任务仍写入 nextRunAt
 *  4. 路由组：chat 标签 / vision 标签；配额用尽后自动切换下一个服务
 *  5. 主动问候：空闲设置 + 立即生成 → 真实模型消息落进最近会话
 *
 * 前置：brain 已启动（默认 3002）且 LLM 可用（services/brain/.env）。
 * 测试自建用户/任务/服务/临时文件，结束统一清理。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'

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
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(300)
  }
}
async function runTurn(userId, sessionId, content, attachments) {
  const res = await fetch(`${BRAIN}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionId, content, ...(attachments ? { attachments } : {}) })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`回合 HTTP ${res.status}: ${text.slice(0, 120)}`)
  return text.includes('"type":"done"')
}
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

const stamp = Date.now()
const username = `e2e-trig-${stamp}`
const dir = mkdtempSync(join(tmpdir(), 'amadeus-trigger-e2e-'))
const createdSessions = []
const createdAutomations = []
const createdProviders = []

async function cleanup() {
  for (const id of createdAutomations) {
    await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdSessions) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of createdProviders) {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
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
  const userId = login.body.userId
  report('用户：创建测试身份', Boolean(userId), username)

  // ================= Webhook 自动化 =================
  let res = await jsonApi('/api/automations', 'POST', {
    userId,
    name: `Webhook 任务 ${stamp}`,
    prompt: '只回复四个字：触发成功。不要调用工具。',
    trigger: 'webhook'
  })
  const webhookAutomation = res.body.automation
  createdAutomations.push(webhookAutomation?.id)
  report(
    'Webhook：创建并生成密钥',
    res.status === 200 &&
      webhookAutomation?.trigger === 'webhook' &&
      webhookAutomation?.nextRunAt === null &&
      String(webhookAutomation?.webhookSecret ?? '').length >= 16
  )

  res = await api(`/api/automations/${webhookAutomation.id}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-amadeus-secret': 'wrong' },
    body: JSON.stringify({ text: 'release 1.2' })
  })
  report('Webhook：错误密钥被拒绝', res.status === 401)

  res = await api(`/api/automations/${webhookAutomation.id}/trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-amadeus-secret': webhookAutomation.webhookSecret
    },
    body: JSON.stringify({ text: 'release 1.2' })
  })
  report('Webhook：正确密钥返回 202', res.status === 202)
  const webhookDone = await waitFor(async () => {
    const list = await api(`/api/automations?userId=${userId}`)
    const item = list.body.automations?.find((row) => row.id === webhookAutomation.id)
    return item && ['success', 'error'].includes(item.lastStatus) ? item : null
  }, 180_000, 'Webhook 回合').catch(() => null)
  report(
    'Webhook：真实回合执行并记录触发来源',
    webhookDone?.lastStatus === 'success' &&
      webhookDone.lastTrigger.includes('release 1.2') &&
      String(webhookDone.lastResult).length > 0,
    `${webhookDone?.lastStatus} ${webhookDone?.lastResult}`
  )
  createdSessions.push(`automation-${webhookAutomation.id}`)

  // ================= 文件变化自动化 =================
  const watched = join(dir, 'watched')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(watched, { recursive: true })
  res = await jsonApi('/api/automations', 'POST', {
    userId,
    name: `文件任务 ${stamp}`,
    prompt: '只回复四个字：文件变化。不要调用工具。',
    trigger: 'file',
    watchPath: watched,
    debounceSeconds: 1
  })
  const fileAutomation = res.body.automation
  createdAutomations.push(fileAutomation?.id)
  report(
    '文件触发：创建并监听目录',
    res.status === 200 && fileAutomation?.trigger === 'file' && fileAutomation?.watchPath === watched
  )

  await sleep(800)
  writeFileSync(join(watched, 'change.txt'), `change-${stamp}`)
  const fileDone = await waitFor(async () => {
    const list = await api(`/api/automations?userId=${userId}`)
    const item = list.body.automations?.find((row) => row.id === fileAutomation.id)
    return item && ['success', 'error'].includes(item.lastStatus) ? item : null
  }, 180_000, '文件触发回合').catch(() => null)
  report(
    '文件触发：写入文件后真实回合执行',
    fileDone?.lastStatus === 'success' && fileDone.lastTrigger.includes('文件变化'),
    `${fileDone?.lastStatus} ${fileDone?.lastTrigger}`
  )
  createdSessions.push(`automation-${fileAutomation.id}`)

  // ================= 定时任务仍正常排期 =================
  res = await jsonApi('/api/automations', 'POST', {
    userId,
    name: `定时任务 ${stamp}`,
    prompt: '定时测试',
    trigger: 'schedule',
    schedule: 'interval',
    intervalMinutes: 30
  })
  createdAutomations.push(res.body.automation?.id)
  report(
    '定时触发：仍写入 nextRunAt',
    typeof res.body.automation?.nextRunAt === 'number' &&
      res.body.automation.nextRunAt > Date.now() + 29 * 60_000
  )

  // ================= 路由组与配额 =================
  const envMap = readEnv(new URL('../services/brain/.env', import.meta.url))
  if (!envMap.LLM_API_KEY || !envMap.LLM_BASE_URL) {
    report('路由组：跳过（.env 没有真实 LLM 配置）', true, 'not run')
    report('主动问候：跳过（.env 没有真实 LLM 配置）', true, 'not run')
  } else {
    const base = {
      baseUrl: envMap.LLM_BASE_URL,
      model: envMap.AI_MODEL || 'deepseek-v4-pro',
      apiKey: envMap.LLM_API_KEY
    }
    const quotaProvider = await jsonApi('/api/providers', 'POST', {
      ...base,
      name: `配额服务 ${stamp}`,
      tags: ['chat'],
      dailyTokenQuota: 1,
      priority: 1
    })
    const backupProvider = await jsonApi('/api/providers', 'POST', {
      ...base,
      name: `备用服务 ${stamp}`,
      tags: ['chat'],
      dailyTokenQuota: 0,
      priority: 2
    })
    createdProviders.push(quotaProvider.body.provider?.id, backupProvider.body.provider?.id)
    await jsonApi(`/api/providers/${quotaProvider.body.provider.id}/active`, 'PUT')

    const routeSessionA = `route-a-${stamp}`
    const routeSessionB = `route-b-${stamp}`
    createdSessions.push(routeSessionA, routeSessionB)
    await runTurn(userId, routeSessionA, '只回复：配额一')
    await runTurn(userId, routeSessionB, '只回复：配额二')

    const providers = (await api('/api/providers')).body.providers ?? []
    const quotaRow = providers.find((item) => item.id === quotaProvider.body.provider.id)
    report(
      '路由组：配额用尽后标记超额并切换服务',
      quotaRow?.quotaExceeded === true && quotaRow?.todayTokens > 1
    )
    const stats = (await api(`/api/stats?userId=${userId}&days=7`)).body
    const quotaTurns = stats.providers?.find((item) => item.name.startsWith('配额服务'))?.turns ?? 0
    const backupTurns = stats.providers?.find((item) => item.name.startsWith('备用服务'))?.turns ?? 0
    report(
      '路由组：第二个回合实际使用备用服务',
      quotaTurns === 1 && backupTurns >= 1,
      `quota=${quotaTurns} backup=${backupTurns}`
    )

    // 标签路由：vision 组只接带图片的回合
    const visionProvider = await jsonApi('/api/providers', 'POST', {
      ...base,
      name: `视觉服务 ${stamp}`,
      tags: ['vision'],
      dailyTokenQuota: 0,
      priority: 3
    })
    createdProviders.push(visionProvider.body.provider?.id)
    await jsonApi(`/api/providers/${visionProvider.body.provider.id}/active`, 'PUT')
    const visionSession = `route-vision-${stamp}`
    createdSessions.push(visionSession)
    await runTurn(userId, visionSession, '这张图里有什么？只回复：收到', [
      { name: 'dot.png', mimeType: 'image/png', data: PNG_1PX }
    ])
    const statsAfterVision = (await api(`/api/stats?userId=${userId}&days=7`)).body
    report(
      '路由组：图片回合进入 vision 标签服务',
      (statsAfterVision.providers?.find((item) => item.name.startsWith('视觉服务'))?.turns ?? 0) >= 1
    )

    // ================= 主动问候 =================
    const proactiveUser = (await jsonApi('/api/users/login', 'POST', {
      username: `e2e-proactive-${stamp}`
    })).body.userId
    const proactiveSession = `proactive-${stamp}`
    createdSessions.push(proactiveSession)
    await runTurn(proactiveUser, proactiveSession, '只回复：你好')
    const settings = await jsonApi('/api/proactive', 'PUT', {
      userId: proactiveUser,
      enabled: true,
      minIdleMinutes: 5,
      activeStart: '00:00',
      activeEnd: '23:59',
      maxPerDay: 3
    })
    report('主动问候：保存设置', settings.status === 200 && settings.body.settings?.enabled === true)
    const greeting = await jsonApi('/api/proactive/run', 'POST', { userId: proactiveUser })
    report(
      '主动问候：真实模型生成消息',
      greeting.status === 200 && String(greeting.body.greeting?.content ?? '').length > 3,
      String(greeting.body.greeting?.content ?? '').slice(0, 50)
    )
    const after = (await api(`/api/proactive?userId=${proactiveUser}`)).body
    report(
      '主动问候：写入最近会话并记录次数',
      after.todayCount === 1 &&
        after.latest?.sessionId === proactiveSession &&
        (await api(`/api/sessions/${proactiveSession}/messages`)).body.messages?.some(
          (message) => message.role === 'assistant' && message.content === after.latest.content
        )
    )
  }
} catch (error) {
  console.error('E2E 异常：', error)
  report('脚本执行完成', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanupOnce()
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
if (passed !== results.length) process.exitCode = 1
