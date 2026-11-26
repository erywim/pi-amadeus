/**
 * 模型调度契约（来源：PIAM-11 方案 A 的模型调度部分）。
 * 操作序列：路由策略（标签/冷却/配额/内置回落）→ 每回合只选一次模型 →
 * model 覆盖重算 vision → 选择结果不写回用户配置 → 只读接口不回传密钥。
 * 直接运行：node scripts/e2e-model-dispatch.mjs
 * 临时 SQLite + 进程内 mock Db；不启动服务、不读 .env、不访问真实模型/账号。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startMockLlm } from './mock-llm.mjs'

const dir = mkdtempSync(join(tmpdir(), 'amadeus-model-dispatch-'))
// prepareTurn 读取图片附件需要真实文件；1x1 PNG 即可，不访问网络。
const imagePath = join(dir, 'pixel.png')
writeFileSync(
  imagePath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3QCwAAAABJRU5ErkJggg==',
    'base64'
  )
)

const SECRET = 'sk-dispatch-contract-secret'
const cfg = {
  port: 0,
  db: { path: join(dir, 'dispatch.db') },
  llm: { baseUrl: 'https://env.example/v1', apiKey: 'sk-env', model: 'env-model' },
  tools: { tavilyKey: '', confirmTimeoutMs: 1000, bashCwd: dir },
  media: { dir: join(dir, 'media') },
  skills: { dir: join(dir, 'skills') }
}

const { createDb } = await import('../services/brain/src/db.ts')
const { prepareTurn } = await import('../services/brain/src/conversation.ts')
const { clearProviderFailures, markProviderFailure } = await import(
  '../services/brain/src/providers/failover.ts'
)

let db

function provider(overrides = {}) {
  return {
    id: randomUUID(),
    name: 'contract-provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: SECRET,
    model: 'text-only',
    proxy: '',
    tags: 'chat',
    dailyTokenQuota: 0,
    thinkingLevel: 'off',
    contextWindow: 0,
    maxTokens: 0,
    enabled: true,
    active: false,
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

/** 只实现 resolveTarget 用到的接口；listProviders 按生产 SQL 的顺序返回。 */
function fakeDb(providers, config = null, usage = {}) {
  return {
    async listProviders() {
      return [...providers].sort((a, b) =>
        Number(b.active) - Number(a.active) || a.priority - b.priority
      )
    },
    async getUserConfig() {
      return config
    },
    async providerUsageToday(id) {
      return usage[id] ?? 0
    }
  }
}

function counted(db) {
  const stats = { listProviders: 0, getUserConfig: 0 }
  return {
    stats,
    db: {
      ...db,
      listProviders: (...args) => {
        stats.listProviders += 1
        return db.listProviders(...args)
      },
      getUserConfig: (...args) => {
        stats.getUserConfig += 1
        return db.getUserConfig(...args)
      }
    }
  }
}

function userConfig(model = 'configured-model') {
  return {
    provider: { baseUrl: 'https://configured.example/v1', apiKey: 'sk-configured', model },
    outputLanguage: 'zh',
    systemPrompt: '',
    tools: { enabled: false }
  }
}

try {
  db = createDb(cfg.db)
  await db.init()
  const userId = (await db.resolveUser('dispatch-contract')).id
  const sessionId = `dispatch-${userId}`

  // ---- 单次选择：这是先于其它用例、能在旧实现上跑红的行为断言 ----

  await test('prepareTurn 每回合只调用一次模型调度（含图片附件与 model 覆盖）', async () => {
    clearProviderFailures()
    const chat = await db.createProvider({
      name: 'chat', baseUrl: 'https://chat.example/v1', apiKey: 'sk-chat', model: 'text-only',
      proxy: '', tags: 'chat', dailyTokenQuota: 0, thinkingLevel: 'off',
      contextWindow: 0, maxTokens: 0, enabled: true, priority: 10
    })
    const vision = await db.createProvider({
      name: 'vision', baseUrl: 'https://vision.example/v1', apiKey: 'sk-vision', model: 'gpt-4o-mini',
      proxy: '', tags: 'vision', dailyTokenQuota: 0, thinkingLevel: 'off',
      contextWindow: 0, maxTokens: 0, enabled: true, priority: 20
    })
    await db.setActiveProvider(chat.id)
    await db.setUserConfig(userId, userConfig())

    try {
      const first = counted(db)
      const withImage = await prepareTurn({
        cfg, db: first.db, userId, sessionId: `${sessionId}-image`, channel: 'desktop', mode: 'text',
        content: '看看这张图', attachments: [
          { id: randomUUID(), kind: 'image', name: 'pixel.png', mimeType: 'image/png', size: 68, path: imagePath, extractedText: null }
        ]
      })
      assert.equal(first.stats.listProviders, 1, '图片回合只能选一次（旧实现会选两次）')
      assert.equal(withImage.target.model, 'gpt-4o-mini', '图片附件必须走 vision 路由')
      assert.equal(withImage.target.vision, true)

      const second = counted(db)
      const voice = await prepareTurn({
        cfg, db: second.db, userId, sessionId: `${sessionId}-voice`, channel: 'desktop', mode: 'voice',
        content: '听的见我么', frames: ['ZmFrZQ==']
      })
      assert.equal(second.stats.listProviders, 1, '语音回合也只能选一次')
      assert.equal(voice.target.model, 'text-only', '语音帧沿用 chat 路由，不因为带帧改走 vision')

      const third = counted(db)
      const overridden = await prepareTurn({
        cfg, db: third.db, userId, sessionId: `${sessionId}-override`, channel: 'desktop', mode: 'text',
        content: '换个模型', model: 'gpt-4o-mini'
      })
      assert.equal(third.stats.listProviders, 1, '带 model 覆盖的回合只能选一次')
      assert.equal(overridden.target.model, 'gpt-4o-mini', 'TurnContext.model 必须覆盖最终模型')
      assert.equal(overridden.target.vision, true, '覆盖模型后按新模型重算 vision')
    } finally {
      await db.setActiveProvider(vision.id)
      await db.deleteProvider(chat.id)
      await db.deleteProvider(vision.id)
      clearProviderFailures()
    }
  })

  // ---- 路由策略 ----

  await test('路由策略：激活服务优先，标签/冷却/配额不满足时按顺序换下一个', async () => {
    const { resolveTarget } = await import('../services/brain/src/runtime/model-dispatcher.ts')
    const active = provider({ name: 'active', active: true, model: 'active-model' })
    const backup = provider({ name: 'backup', priority: 20, model: 'backup-model' })
    let target = await resolveTarget(cfg, fakeDb([active, backup]), 'u')
    assert.equal(target.providerId, active.id)
    assert.equal(target.model, 'active-model')
    assert.equal(target.apiKey, SECRET, '内部 target 仍需携带密钥以执行请求')

    const visionOnly = provider({ name: 'vision-only', active: true, tags: 'vision', model: 'gpt-4o-mini' })
    target = await resolveTarget(cfg, fakeDb([visionOnly, backup]), 'u')
    assert.equal(target.providerId, backup.id, '标签不匹配时换下一个可用服务')

    clearProviderFailures()
    markProviderFailure(active.id)
    try {
      target = await resolveTarget(cfg, fakeDb([active, backup]), 'u')
      assert.equal(target.providerId, backup.id, '冷却中的服务必须跳过')
    } finally {
      clearProviderFailures()
    }

    const overQuota = { ...active, dailyTokenQuota: 100 }
    target = await resolveTarget(
      cfg,
      fakeDb([overQuota, backup], null, { [active.id]: 100 }),
      'u'
    )
    assert.equal(target.providerId, backup.id, '额度用尽的服务必须跳过')
    assert.equal(
      (await resolveTarget(cfg, fakeDb([overQuota, backup], null, { [active.id]: 99 }), 'u')).providerId,
      active.id,
      '未超配额时仍用激活服务'
    )
  })

  await test('路由策略：vision 组接受标签 chat 的视觉模型，纯文本 chat 服务不可用于 vision', async () => {
    const { resolveTarget } = await import('../services/brain/src/runtime/model-dispatcher.ts')
    const textChat = provider({ name: 'text', active: true, tags: 'chat', model: 'text-only' })
    const imageChat = provider({ name: 'image', tags: 'chat', model: 'gpt-4o-mini', priority: 20 })
    const visionTagged = provider({ name: 'vision', tags: 'vision', model: 'qwen-vl-max', priority: 30 })
    const target = await resolveTarget(cfg, fakeDb([textChat, imageChat, visionTagged]), 'u', 'vision')
    assert.equal(target.providerId, imageChat.id, 'chat 标签 + 视觉模型可以承接 vision')
    assert.equal(target.vision, true)
    const onlyText = await resolveTarget(
      cfg,
      fakeDb([textChat, provider({ name: 'second-text', tags: 'chat', model: 'text-only', priority: 20 })]),
      'u',
      'vision'
    )
    assert.equal(onlyText.providerId, '', '没有可承接 vision 的服务时回落内置配置')
  })

  await test('路由策略：没有可用服务时按用户配置 → .env 默认逐字段回落', async () => {
    const { resolveTarget } = await import('../services/brain/src/runtime/model-dispatcher.ts')
    const noProviders = fakeDb([], userConfig('configured-model'))
    let target = await resolveTarget(cfg, noProviders, 'u')
    assert.equal(target.providerId, '')
    assert.equal(target.model, 'configured-model')
    assert.equal(target.baseUrl, 'https://configured.example/v1')
    assert.equal(target.apiKey, 'sk-configured')

    target = await resolveTarget(cfg, fakeDb([], null), 'u')
    assert.equal(target.model, 'env-model')
    assert.equal(target.baseUrl, 'https://env.example/v1')
    assert.equal(target.apiKey, 'sk-env')
    assert.equal(target.vision, false)
  })

  await test('model 覆盖：重算 vision，且不写回用户配置', async () => {
    const { resolveTarget } = await import('../services/brain/src/runtime/model-dispatcher.ts')
    const config = userConfig('text-only')
    const before = JSON.parse(JSON.stringify(config))
    const active = provider({ active: true, model: 'text-only' })

    let target = await resolveTarget(cfg, fakeDb([active], config), 'u', 'chat', { model: 'gpt-4o-mini' })
    assert.equal(target.model, 'gpt-4o-mini')
    assert.equal(target.vision, true, '覆盖为视觉模型后 vision 必须重算为 true')
    assert.equal(target.apiKey, SECRET)
    assert.deepEqual(config, before, '调度只读，不得改写用户配置')

    target = await resolveTarget(cfg, fakeDb([active], config), 'u', 'chat', { model: 'deepseek-v4-pro' })
    assert.equal(target.vision, false, '覆盖为纯文本模型后 vision 必须重算为 false')
    assert.deepEqual(config, before)
  })

  await test('语音实际模型目标跟随执行结果返回，调用期间配置变化不二次调度', async () => {
    const { runVoiceTurn } = await import('../services/brain/src/conversation.ts')
    const selected = 'voice-selected'
    const mock = await startMockLlm(async body => {
      assert.equal(body.model, selected)
      await db.setUserConfig(userId, { ...userConfig('changed-mid-turn'), compaction: { level: 'off' } })
      return { text: '语音回复' }
    })
    try {
      await db.setUserConfig(userId, { ...userConfig(), compaction: { level: 'off' },
        provider: { baseUrl: mock.url, apiKey: 'test', model: selected } })
      const countedDb = counted(db)
      const run = runVoiceTurn({ cfg, db: countedDb.db, userId, sessionId: `${sessionId}-voice-result`,
        channel: 'desktop', mode: 'voice', content: '说句话', isolated: true }, new AbortController().signal,
      { apiKey: '', voice: '', model: '', endpoint: mock.url, sampleRate: 24000, proxy: '' })
      let step = await run.next()
      while (!step.done) step = await run.next()
      assert.equal(step.value.target.model, selected)
      assert.equal(step.value.cn, '语音回复')
      assert.equal(countedDb.stats.listProviders, 1)
      assert.equal((await db.getUserConfig(userId)).provider.model, 'changed-mid-turn')
    } finally { await mock.close() }
  })
  await test('只读运行时接口不回传密钥、端点或代理', async () => {
    const { Hono } = await import('hono')
    const { configRoutes } = await import('../services/brain/src/routes/config.ts')
    const active = await db.createProvider({
      name: 'runtime-contract', baseUrl: 'https://runtime.example/v1', apiKey: SECRET, model: 'gpt-4o-mini',
      proxy: 'http://127.0.0.1:7890', tags: 'chat', dailyTokenQuota: 0, thinkingLevel: 'off',
      contextWindow: 0, maxTokens: 0, enabled: true, priority: 1
    })
    await db.setActiveProvider(active.id)
    try {
      const app = new Hono().route('/api', configRoutes(cfg, db))
      const response = await app.request(`/api/config/${userId}/runtime`)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.model, 'gpt-4o-mini')
      const raw = JSON.stringify(body)
      for (const secret of [SECRET, 'runtime.example', '127.0.0.1:7890']) {
        assert.equal(raw.includes(secret), false, `运行时接口不得暴露 ${secret}`)
      }
    } finally {
      await db.deleteProvider(active.id)
    }
  })
} finally {
  clearProviderFailures()
  if (db) await db.close()
  rmSync(dir, { recursive: true, force: true })
}

await test('清理契约：临时目录已删除', async () => {
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(dir), false)
})
