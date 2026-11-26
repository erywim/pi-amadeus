/**
 * 业务回归契约（来源：本轮已核实的群归属 / 附件入口 / 调度覆盖 / 问候会话报告）。
 * 操作序列：群内换人和绑定；队首成功/失败 → 后继阻塞时继续入队 → 排空清理；纯附件网关事件；卡住运行 → PATCH 计划 → 放行；置顶/归档后问候。
 * 直接运行：node scripts/e2e-regression-contracts.mjs
 * 临时 SQLite + 本地 HTTP/WS 平台，模型/记忆边界用 mock；不启动桌面、不读取 .env、不访问真实账号。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setImmediate as nextLoop } from 'node:timers/promises'
import { URL } from 'node:url'
import { WebSocketServer } from 'ws'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function within(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`未收到 ${label}`)), 2500)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const now = 1_800_000_000_000
const realNow = Date.now
Date.now = () => now
const dir = mkdtempSync(join(tmpdir(), 'amadeus-regression-contracts-'))
const turns = []
const finishes = []
const gates = new Map()
const target = { model: 'contract-model', providerName: 'mock' }
const mockKey = Symbol.for('amadeus.regression-contracts')
const mocks = {
  async *runAgentTurn(opts) {
    turns.push(opts)
    const gate = gates.get(opts.sessionId)
    if (gate) {
      gate.started.resolve()
      await gate.release.promise
      if (gate.fail) throw new Error('注入的回合失败')
    }
    await opts.db.touchSession({ id: opts.sessionId, userId: opts.userId, channel: opts.channel })
    await opts.db.appendMessage({
      id: randomUUID(), sessionId: opts.sessionId, role: 'user', content: opts.content, mode: 'text'
    })
    yield { type: 'delta', delta: '契约测试回复' }
    return {
      full: '契约测试回复', target, usage: { input: 1, output: 1, total: 2 }, toolCalls: 0, toolNames: []
    }
  },
  async finishTurn(db, input) {
    finishes.push(input)
    const id = randomUUID()
    await db.appendMessage({ id, sessionId: input.sessionId, role: 'assistant', content: input.content, mode: 'text' })
    await db.touchSession({ id: input.sessionId, userId: input.userId, channel: input.channel })
    return id
  },
  resolveTarget: async () => target,
  completeText: async () => '记得歇一歇。',
  recallMemories: async () => [],
  summarizeAffinity: async () => '',
  memorySystemPrompt: () => '',
  buildSystemPrompt: () => '契约测试人格'
}
// 只替换外部生成/回合边界；被测管线、适配器、调度器和 SQLite 均加载真实源码。
globalThis[mockKey] = mocks
const mockedModules = new Map([
  ['agentTurn.ts', ['runAgentTurn']],
  ['conversation.ts', ['finishTurn']],
  // resolveTarget 已移入 runtime/model-dispatcher.ts；主动问候直接从这里取目标
  ['runtime/model-dispatcher.ts', ['resolveTarget']],
  ['llm.ts', ['completeText']],
  ['memory/index.ts', ['recallMemories', 'summarizeAffinity', 'memorySystemPrompt']],
  ['persona.ts', ['buildSystemPrompt']]
].map(([file, exports]) => [new URL(`../services/brain/src/${file}`, import.meta.url).href, exports]))
const pipelineUrl = new URL('../services/brain/src/platforms/pipeline.ts', import.meta.url).href
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === pipelineUrl) {
      const loaded = nextLoad(url, context)
      // 仅让测试观察队列资源生命周期；生产入口不增加调试导出或管理接口。
      return { ...loaded, source: `${loaded.source}\nexport { sessionQueues };` }
    }
    const exports = mockedModules.get(url)
    if (!exports) return nextLoad(url, context)
    return {
      format: 'module', shortCircuit: true,
      source: `const mock = globalThis[Symbol.for('amadeus.regression-contracts')];\n${exports.map((name) => `export const ${name} = (...args) => mock.${name}(...args);`).join('\n')}`
    }
  }
})

let db
let sql
let scheduler
const resources = []
try {
  const [{ createDb }, { handlePlatformMessage, sessionQueues }, { automationScheduler }, { automationRoutes },
    { generateProactiveGreeting }, { computeNextRun }, { DiscordAdapter }, { SlackAdapter }] = await Promise.all([
    import('../services/brain/src/db.ts'),
    import('../services/brain/src/platforms/pipeline.ts'),
    import('../services/brain/src/automation/scheduler.ts'),
    import('../services/brain/src/routes/automations.ts'),
    import('../services/brain/src/proactive/index.ts'),
    import('../services/brain/src/automation/schedule.ts'),
    import('../services/brain/src/platforms/discord.ts'),
    import('../services/brain/src/platforms/slack.ts')
  ])
  scheduler = automationScheduler
  db = createDb({ path: join(dir, 'contracts.db') })
  await db.init()
  sql = new DatabaseSync(join(dir, 'contracts.db'))
  const cfg = { media: { dir: join(dir, 'media') }, whisper: { apiKey: '', baseUrl: '' } }
  const app = automationRoutes(db)
  const platform = await db.createPlatform({ kind: 'webhook', name: 'contract', enabled: true, config: {} })
  const alpha = await db.resolveUser('webhook-alpha')
  const beta = await db.resolveUser('webhook-beta')
  const desktop = await db.resolveUser('desktop-owner')
  await db.setBindCode(desktop.id, 'contract-bind')
  const sessionId = (type, id) => `${platform.id}-${type}-${id}`
  async function inbound(user, chatType, chatId, text = '你好') {
    const replies = []
    await handlePlatformMessage({
      cfg, db, platform, inbound: { externalUserId: user, chatType, chatId, text },
      reply: async (content) => { replies.push(content) }
    })
    return replies
  }

  await test('群内换说话人：会话、回合与指标保持首位 owner', async () => {
    const id = sessionId('group', 'group-speakers')
    await inbound('alpha', 'group', 'group-speakers')
    await inbound('beta', 'group', 'group-speakers')
    assert.equal((await db.getSession(id)).userId, alpha.id, '换说话人不能转移群历史')
    assert.deepEqual(turns.filter((item) => item.sessionId === id).map((item) => item.userId), [alpha.id, alpha.id])
    assert.deepEqual(finishes.filter((item) => item.sessionId === id).map((item) => item.userId), [alpha.id, alpha.id])
    const owners = sql.prepare('SELECT DISTINCT user_id FROM turn_metrics WHERE session_id = ?').all(id)
    assert.deepEqual(owners.map((item) => item.user_id), [alpha.id])
  })

  await test('并发首轮：排队后的群消息沿用已经建立的 owner', async () => {
    const id = sessionId('group', 'group-concurrent')
    const gate = { started: deferred(), release: deferred() }
    gates.set(id, gate)
    const first = inbound('alpha', 'group', 'group-concurrent')
    let second
    try {
      await within(gate.started.promise, '首位群成员的回合')
      second = inbound('beta', 'group', 'group-concurrent')
      // 让第二条消息走到它自己的等待点，而非用 sleep 猜测竞争窗口。
      await nextLoop()
    } finally {
      gate.release.resolve()
      await Promise.all([first, second])
      gates.delete(id)
    }
    assert.equal((await db.getSession(id)).userId, alpha.id)
    assert.deepEqual(turns.filter((item) => item.sessionId === id).map((item) => item.userId), [alpha.id, alpha.id])
  })

  await test('/bind：只迁移绑定者私聊，不迁移群或其它人的私聊', async () => {
    await inbound('alpha', 'private', 'dm-alpha')
    await inbound('beta', 'private', 'dm-beta')
    await inbound('alpha', 'group', 'group-bind')
    await inbound('beta', 'group', 'group-bind', '/bind contract-bind')
    assert.equal((await db.findPlatformAccount(platform.id, 'beta')).userId, desktop.id)
    assert.equal((await db.getSession(sessionId('group', 'group-bind'))).userId, alpha.id)
    assert.equal((await db.getSession(sessionId('private', 'dm-beta'))).userId, beta.id)
    await inbound('beta', 'private', 'dm-beta')
    assert.equal((await db.getSession(sessionId('private', 'dm-beta'))).userId, desktop.id)
    assert.equal((await db.getSession(sessionId('private', 'dm-alpha'))).userId, alpha.id)
    await inbound('beta', 'group', 'group-bind')
    assert.equal((await db.getSession(sessionId('group', 'group-bind'))).userId, alpha.id)
    await inbound('alpha', 'private', 'dm-alpha', '/bind contract-bind')
    assert.equal((await db.getSession(sessionId('private', 'dm-alpha'))).userId, desktop.id, '私聊绑定后立即可见历史')
    assert.equal((await db.getSession(sessionId('group', 'group-bind'))).userId, alpha.id)
    await inbound('alpha', 'group', 'group-bind', '/bind contract-bind')
    await inbound('alpha', 'group', 'group-bind')
    assert.equal((await db.getSession(sessionId('group', 'group-bind'))).userId, alpha.id, '群 owner 自己绑定也不迁移群')
    const accountBefore = await db.findPlatformAccount(platform.id, 'alpha')
    const replies = await inbound('alpha', 'private', 'dm-alpha', '/bind invalid-code')
    assert.match(replies[0], /无效/)
    assert.deepEqual(await db.findPlatformAccount(platform.id, 'alpha'), accountBefore)
  })

  await test('队列释放：多会话成功后不保留已完成的 Promise', async () => {
    const before = sessionQueues.size
    for (let index = 0; index < 12; index += 1) {
      const chatId = `queue-complete-${index}`
      await inbound('alpha', 'private', chatId)
      assert.equal(sessionQueues.has(sessionId('private', chatId)), false)
    }
    assert.equal(sessionQueues.size, before)
  })

  await test('队列释放：绑定回复失败保留原错误，后续消息仍能执行', async () => {
    const chatId = 'queue-reject'
    await assert.rejects(handlePlatformMessage({
      cfg, db, platform,
      inbound: { externalUserId: 'alpha', chatType: 'private', chatId, text: '/bind contract-bind' },
      reply: async () => { throw new Error('注入的绑定回复失败') }
    }), /注入的绑定回复失败/)
    assert.equal(sessionQueues.has(sessionId('private', chatId)), false)
    assert.deepEqual(await inbound('alpha', 'private', chatId), ['契约测试回复'])
    assert.equal(sessionQueues.has(sessionId('private', chatId)), false)
  })

  for (const failFirst of [false, true]) {
    await test(`队列并发：队首${failFirst ? '失败' : '成功'}不清掉后继，新消息不越过等待中的回复`, async () => {
      const chatId = `queue-pending-${failFirst}`
      const id = sessionId('private', chatId)
      const firstStarted = deferred()
      const firstRelease = deferred()
      const secondStarted = deferred()
      const secondRelease = deferred()
      const order = []
      const dispatch = (name, started, release, fail = false) => handlePlatformMessage({
        cfg, db, platform,
        inbound: { externalUserId: 'alpha', chatType: 'private', chatId, text: '/bind contract-bind' },
        reply: async () => {
          order.push(`${name}:start`)
          started?.resolve()
          if (release) await release.promise
          if (fail) throw new Error('注入的队首失败')
          order.push(`${name}:end`)
        }
      })
      const first = dispatch('first', firstStarted, firstRelease, failFirst)
      const outcome = first.then(() => null, (error) => error)
      let second
      let third
      try {
        await within(firstStarted.promise, '队首绑定回复')
        second = dispatch('second', secondStarted, secondRelease)
        await nextLoop()
        assert.deepEqual(order, ['first:start'])
        const pending = sessionQueues.get(id)
        assert.ok(pending)
        firstRelease.resolve()
        await within(secondStarted.promise, '后继绑定回复')
        const error = await outcome
        if (failFirst) assert.match(error?.message ?? '', /注入的队首失败/)
        else assert.equal(error, null)
        assert.equal(sessionQueues.get(id), pending, '已结束的队首不能删除尚未完成的后继')
        third = dispatch('third')
        await nextLoop()
        const beforeRelease = failFirst ? ['first:start', 'second:start'] : ['first:start', 'first:end', 'second:start']
        assert.deepEqual(order, beforeRelease, '第三条消息必须继续等待第二条')
        secondRelease.resolve()
        await Promise.all([second, third])
        assert.deepEqual(order, [...beforeRelease, 'second:end', 'third:start', 'third:end'])
        assert.equal(sessionQueues.has(id), false, '排空后释放队列条目')
      } finally {
        firstRelease.resolve()
        secondRelease.resolve()
        await Promise.allSettled([first, second, third])
      }
    })
  }

  async function adapterHarness(kind, Adapter) {
    const received = []
    const waiting = new Map()
    const downloads = []
    const gateway = new WebSocketServer({ noServer: true })
    const connected = deferred()
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/users/@me') return res.end(JSON.stringify({ id: 'self', username: 'contract' }))
      if (req.url === '/auth.test') return res.end(JSON.stringify({ ok: true, user_id: 'self' }))
      if (req.url === '/apps.connections.open') {
        return res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${server.address().port}/gateway` }))
      }
      if (req.url === '/file.txt') {
        downloads.push(req.headers.authorization ?? '')
        res.setHeader('Content-Type', 'text/plain')
        return res.end('附件原始字节')
      }
      res.writeHead(404).end('{}')
    })
    server.on('upgrade', (req, socket, head) => {
      gateway.handleUpgrade(req, socket, head, (ws) => gateway.emit('connection', ws, req))
    })
    gateway.on('connection', (socket) => {
      socket.send(JSON.stringify(kind === 'discord' ? { op: 10, d: { heartbeat_interval: 45_000 } } : { type: 'hello' }))
      connected.resolve(socket)
    })
    const resource = {
      server, gateway, adapter: null,
      async close() {
        resource.adapter?.stop()
        for (const socket of gateway.clients) socket.terminate()
        await new Promise((resolve) => gateway.close(resolve))
        const closed = new Promise((resolve) => server.close(resolve))
        server.closeAllConnections()
        await closed
      }
    }
    resources.push(resource)
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const base = `http://127.0.0.1:${server.address().port}`
      resource.adapter = new Adapter({
        config: { botToken: 'mock-bot', appToken: 'mock-app', apiBaseUrl: base, gatewayUrl: base.replace('http:', 'ws:') },
        onMessage(message) {
          received.push(message)
          waiting.get(message.messageId)?.resolve(message)
        }
      })
      await resource.adapter.start()
      const socket = await within(connected.promise, `${kind} 网关连接`)
      return {
        resource, base, received, downloads,
        send(message) { socket.send(JSON.stringify(message)) },
        async receive(id) {
          const existing = received.find((item) => item.messageId === id)
          if (existing) return existing
          const pending = deferred()
          waiting.set(id, pending)
          try { return await within(pending.promise, `${kind} 入站消息 ${id}`) }
          finally { waiting.delete(id) }
        }
      }
    } catch (error) {
      await resource.close()
      throw error
    }
  }

  await test('Discord Gateway：纯附件进入管线，空消息/bot/自己仍被过滤', async () => {
    const h = await adapterHarness('discord', DiscordAdapter)
    try {
      const dispatch = (d) => h.send({ op: 0, t: 'MESSAGE_CREATE', d })
      dispatch({ id: 'bot', channel_id: 'dm', content: 'ignore', author: { bot: true, id: 'bot' } })
      dispatch({ id: 'self', channel_id: 'dm', content: 'ignore', author: { id: 'self' } })
      dispatch({ id: 'empty', channel_id: 'dm', content: '', author: { id: 'sender' }, attachments: [] })
      dispatch({ id: 'file-only', channel_id: 'dm', content: '', author: { id: 'sender' }, attachments: [
        { url: `${h.base}/file.txt`, filename: '原件.txt', content_type: 'text/plain', size: Buffer.byteLength('附件原始字节') }
      ] })
      dispatch({ id: 'text', channel_id: 'dm', content: '普通文本', author: { id: 'sender' } })
      const message = await h.receive('file-only')
      await h.receive('text')
      assert.equal(message.text, '')
      assert.equal(message.chatType, 'private')
      assert.equal(message.media[0].name, '原件.txt')
      assert.equal(Buffer.from(message.media[0].data, 'base64').toString(), '附件原始字节')
      assert.deepEqual(h.received.map((item) => item.messageId).sort(), ['file-only', 'text'])
    } finally { await h.resource.close() }
  })

  await test('Slack Socket Mode：file_share 纯文件放行，编辑/删除/bot 仍被过滤', async () => {
    const h = await adapterHarness('slack', SlackAdapter)
    try {
      const event = (e) => h.send({ type: 'events_api', envelope_id: `envelope-${e.ts}`, payload: { event: { type: 'message', channel: 'dm', channel_type: 'im', user: 'sender', ...e } } })
      for (const subtype of ['message_changed', 'message_deleted', 'channel_join']) event({ ts: subtype, subtype, text: 'ignore' })
      event({ ts: 'bot', text: 'ignore', bot_id: 'bot' })
      event({ ts: 'self', text: 'ignore', user: 'self' })
      event({ ts: 'empty', text: '', files: [] })
      event({ ts: 'file-only', subtype: 'file_share', text: '', files: [
        { url_private: `${h.base}/file.txt`, name: '原件.txt', mimetype: 'text/plain', size: Buffer.byteLength('附件原始字节') }
      ] })
      event({ ts: 'text', text: '普通文本' })
      const message = await h.receive('file-only')
      await h.receive('text')
      assert.equal(message.text, '')
      assert.equal(message.chatType, 'private')
      assert.equal(Buffer.from(message.media[0].data, 'base64').toString(), '附件原始字节')
      assert.deepEqual(h.downloads, ['Bearer mock-bot'])
      assert.deepEqual(h.received.map((item) => item.messageId).sort(), ['file-only', 'text'])
    } finally { await h.resource.close() }
  })

  async function scheduleCase({ manual = false, initial = {}, edit, fail = false }) {
    const row = await db.createAutomation({
      userId: desktop.id, name: '运行前名称', prompt: '运行前指令', trigger: 'schedule', watchPath: '',
      debounceSeconds: 2, webhookSecret: '', schedule: 'interval', intervalMinutes: 5, timeOfDay: '09:00',
      runAt: null, enabled: true, nextRunAt: manual ? now + 60_000 : now - 60_000, ...initial
    })
    const id = `automation-${row.id}`
    const gate = { started: deferred(), release: deferred(), fail }
    const finished = deferred()
    let started = false
    gates.set(id, gate)
    const schedulerDb = {
      ...db,
      async finishAutomationRun(input) {
        await db.finishAutomationRun(input)
        finished.resolve()
      }
    }
    try {
      await scheduler.init(cfg, schedulerDb)
      if (manual) assert.equal(await scheduler.runNow(row.id), true)
      await within(gate.started.promise, '被延迟的自动化回合')
      started = true
      assert.equal((await db.getAutomation(row.id)).lastStatus, 'running')
      assert.equal(await scheduler.runNow(row.id), false, '运行中不能重复启动')
      let edited = row
      if (edit) {
        const response = await app.request(`/automations/${row.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit)
        })
        assert.equal(response.status, 200, await response.clone().text())
        edited = await db.getAutomation(row.id)
        assert.equal(edited.lastStatus, 'running', '编辑计划不能结束正在执行的回合')
      }
      gate.release.resolve()
      await within(finished.promise, '自动化运行结果写回')
      await nextLoop()
      const current = await db.getAutomation(row.id)
      assert.equal(current.lastStatus, fail ? 'error' : 'success')
      assert.equal(current.lastRunAt, now)
      if (fail) assert.match(current.lastError, /注入的回合失败/)
      else assert.equal(current.lastResult, '契约测试回复')
      assert.equal(turns.find((item) => item.sessionId === id).content.includes('运行前指令'), true)
      return { current, edited }
    } finally {
      gate.release.resolve()
      if (started) await within(finished.promise, '清理前结束自动化回合')
      await nextLoop()
      scheduler.stop()
      gates.delete(id)
      await db.deleteAutomation(row.id)
    }
  }

  for (const [name, options] of [
    ['手动运行中修改间隔', { manual: true, edit: { intervalMinutes: 45, name: '用户新名称', prompt: '用户新指令' } }],
    ['到期 once 改为 interval', { initial: { schedule: 'once', runAt: now - 60_000 }, edit: { schedule: 'interval', intervalMinutes: 45 } }],
    ['到期 once 改到未来', { initial: { schedule: 'once', runAt: now - 60_000 }, edit: { runAt: now + 3_600_000 } }],
    ['运行中停用', { edit: { enabled: false } }],
    ['运行中改为每天', { edit: { schedule: 'daily', timeOfDay: '17:45' } }],
    ['运行中改为 Webhook', { edit: { trigger: 'webhook' } }],
    ['失败回合期间修改计划', { fail: true, edit: { intervalMinutes: 45 } }]
  ]) {
    await test(`自动化 ${name}：完成时保留用户最新计划`, async () => {
      const { current, edited } = await scheduleCase(options)
      assert.equal(current.nextRunAt, edited.nextRunAt, '完成回合不能把新计划覆盖为旧计划')
      assert.equal(current.enabled, edited.enabled, '旧 once 回合不能停用新计划')
      assert.equal(current.schedule, edited.schedule)
      assert.equal(current.trigger, edited.trigger)
      assert.equal(current.name, edited.name)
      assert.equal(current.prompt, edited.prompt)
    })
  }
  await test('自动化未编辑：到期 interval 正常续排，once 自动停用，手动停用任务不排期', async () => {
    const interval = await scheduleCase({})
    assert.equal(interval.current.nextRunAt, now + 5 * 60_000)
    assert.equal(interval.current.enabled, true)
    const onceRun = await scheduleCase({ initial: { schedule: 'once', runAt: now - 60_000 } })
    assert.equal(onceRun.current.nextRunAt, null)
    assert.equal(onceRun.current.enabled, false)
    const manual = await scheduleCase({ manual: true, initial: { enabled: false, nextRunAt: null } })
    assert.equal(manual.current.nextRunAt, null)
    assert.equal(manual.current.enabled, false)
  })
  await test('自动化仅改名称/指令：不妨碍原计划正常续排', async () => {
    const { current } = await scheduleCase({ edit: { name: '改名', prompt: '新指令' } })
    assert.equal(current.nextRunAt, computeNextRun(current, now))
    assert.equal(current.name, '改名')
    assert.equal(current.prompt, '新指令')
  })

  async function makeSession(userId, id, { updatedAt, pinned = false, archived = false, channel = 'desktop' }) {
    await db.touchSession({ id, userId, channel })
    await db.setSessionPinned(id, pinned)
    await db.setSessionArchived(id, archived)
    sql.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, id)
  }
  await test('主动问候：按活动时间选未归档 desktop，不取旧置顶或其它渠道', async () => {
    const user = await db.resolveUser('proactive-latest')
    await makeSession(user.id, 'old-pinned', { updatedAt: now - 3000, pinned: true })
    await makeSession(user.id, 'recent', { updatedAt: now - 1000 })
    await makeSession(user.id, 'archived', { updatedAt: now + 1000, archived: true })
    await makeSession(user.id, 'other-channel', { updatedAt: now + 2000, channel: 'webhook' })
    const greeting = await generateProactiveGreeting(cfg, db, user.id, { force: true })
    assert.equal(greeting?.sessionId, 'recent')
    assert.equal((await db.listMessages('recent')).at(-1)?.content, greeting.content)
    assert.equal((await db.listMessages('old-pinned')).length, 0)
    assert.equal((await db.listMessages('archived')).length, 0)
  })
  await test('主动问候：全部桌面会话已归档时创建新会话，不继续写入归档 fallback', async () => {
    const user = await db.resolveUser('proactive-archived')
    const archivedId = `proactive-${user.id}`
    await makeSession(user.id, archivedId, { updatedAt: now, archived: true })
    const greeting = await generateProactiveGreeting(cfg, db, user.id, { force: true })
    assert.ok(greeting)
    assert.notEqual(greeting.sessionId, archivedId)
    assert.equal((await db.getSession(greeting.sessionId)).archived, false)
    assert.equal((await db.listMessages(archivedId)).length, 0)
  })
  await test('主动问候：新用户沿用原有 fallback 会话 ID', async () => {
    const user = await db.resolveUser('proactive-new')
    const greeting = await generateProactiveGreeting(cfg, db, user.id, { force: true })
    assert.equal(greeting?.sessionId, `proactive-${user.id}`)
  })
} finally {
  for (const gate of gates.values()) gate.release.resolve()
  scheduler?.stop()
  await nextLoop()
  sql?.close()
  if (db) await db.close()
  hooks.deregister()
  delete globalThis[mockKey]
  Date.now = realNow
  rmSync(dir, { recursive: true, force: true })
}
await test('清理契约：临时库已删除，平台连接/监听/调度定时器均已停止', () => {
  assert.equal(existsSync(dir), false)
  assert.equal(globalThis[mockKey], undefined)
  assert.equal(gates.size, 0)
  assert.equal(scheduler.running.size, 0)
  assert.equal(scheduler.timer, null)
  assert.equal(scheduler.watchers.size, 0)
  assert.equal(scheduler.debounceTimers.size, 0)
  for (const resource of resources) {
    assert.equal(resource.server.listening, false)
    assert.equal(resource.gateway.clients.size, 0)
    assert.equal(resource.adapter.status().state, 'stopped')
  }
})
