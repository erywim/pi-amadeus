/**
 * 世界线（会话树 / 分叉与回退）E2E：假 LLM + 临时库 + 独立 brain 子进程。
 *
 *  A 线性对话：一条世界线，消息按父子链接成链
 *  B 重新生成 = 世界线分叉：旧回复留在树上成为兄弟，活动路径仍是"一问一答"
 *  C 世界线跳跃：切到旧回复所在的世界线，内容随之切换
 *  D 回退 + 重说：退回第一条用户消息再发新消息 → 分叉出第三条世界线，
 *    原来的后续内容不丢、不在当前路径上
 *  E 世界线列表：序号 / 变动率 / 预览 / 当前标记
 *  F 跳线清摘要：跳走时压缩摘要作废（摘要属于原世界线）
 *  G 老库迁移：没有 parent_id / active_message_id 的库启动后自动回填成一条链
 *
 * 用法：node scripts/e2e-worldline.mjs
 */
import assert from 'node:assert/strict'
import { startMockLlm } from './mock-llm.mjs'
import { chatTurn, putConfig, resolveUser, startTestBrain } from './test-brain.mjs'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    report(name, true, detail ?? '')
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error))
  }
}

async function json(url, init) {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
  return body
}
const messagesOf = (brain, id) => json(`${brain.url}/api/sessions/${id}/messages`)
const worldlinesOf = (brain, id) => json(`${brain.url}/api/sessions/${id}/worldlines`)
const jumpHead = (brain, id, messageId, toLeaf) =>
  json(`${brain.url}/api/sessions/${id}/head`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageId, toLeaf })
  })

// 每次回复都不同，才能断言"切世界线后看到的是另一版回复"
let replySeq = 0
const mock = await startMockLlm((body) => {
  const system = (body.messages ?? []).find((m) => m.role === 'system' || m.role === 'developer')?.content ?? ''
  const text = typeof system === 'string' ? system : ''
  if (text.includes('长期记忆整理器')) return { text: 'NONE' }
  if (text.includes('标题生成器')) return { text: '世界线测试' }
  if (text.includes('summarizing conversations')) return { text: '<summary>摘要</summary>' }
  replySeq += 1
  return { text: `回复 ${replySeq}` }
})

const brain = await startTestBrain()
const userId = await resolveUser(brain.url, `worldline-e2e-${Date.now()}`)
await putConfig(brain.url, userId, {
  provider: { baseUrl: mock.url, apiKey: 'test-key', model: 'mock-model' },
  compaction: { level: 'off' },
  workflow: { level: 'off' }
})

const sessionId = `wl-${Date.now()}`
let page

try {
  await check('A 线性对话：一条世界线，消息成链', async () => {
    await chatTurn(brain.url, { userId, sessionId, content: '第一问' })
    await chatTurn(brain.url, { userId, sessionId, content: '第二问' })
    page = await messagesOf(brain, sessionId)
    assert.equal(page.messages.length, 4, `应有 4 条消息，实际 ${page.messages.length}`)
    assert.deepEqual(
      page.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant']
    )
    assert.equal(page.messages[0].parentId, null, '根消息父节点应为 null')
    assert.equal(page.messages[1].parentId, page.messages[0].id, '助手应挂在用户消息下')
    assert.equal(page.messages[3].parentId, page.messages[2].id)
    assert.equal(page.worldline.total, 1, `应只有 1 条世界线，实际 ${page.worldline.total}`)
    assert.equal(page.worldline.index, 1)
    assert.equal(page.worldline.headId, page.messages[3].id)
    assert.equal(page.worldline.rewound, false)
  })

  // 重新生成走独立接口（chatTurn 只发普通回合）
  async function regenerate() {
    const res = await fetch(`${brain.url}/api/chat/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, sessionId })
    })
    assert.ok(res.ok, `regenerate HTTP ${res.status}`)
    // 读完 SSE，确保 finishTurn 已落库
    const reader = res.body.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
  }

  let oldAssistant
  await check('B 重新生成 = 世界线分叉，旧回复留在树上', async () => {
    oldAssistant = page.messages[3]
    await regenerate()
    page = await messagesOf(brain, sessionId)
    assert.equal(page.messages.length, 4, `活动路径仍是 4 条，实际 ${page.messages.length}`)
    const newAssistant = page.messages[3]
    assert.notEqual(newAssistant.content, oldAssistant.content, '重新生成应产生不同回复')
    assert.equal(newAssistant.parentId, page.messages[2].id, '新回复应挂在同一条用户消息下')
    assert.deepEqual(
      (newAssistant.siblingIds ?? []).sort(),
      [oldAssistant.id, newAssistant.id].sort(),
      '新旧回复应是兄弟（同一父节点）'
    )
    assert.equal(page.worldline.total, 2, `应分叉出 2 条世界线，实际 ${page.worldline.total}`)
    assert.equal(page.worldline.index, 2, '当前应在第 2 条世界线')
  })

  await check('C 世界线跳跃：切到旧回复那条世界线', async () => {
    page = await jumpHead(brain, sessionId, oldAssistant.id, true)
    assert.equal(page.messages.length, 4)
    assert.equal(page.messages[3].id, oldAssistant.id, '应看到旧版本回复')
    assert.equal(page.messages[3].content, oldAssistant.content)
    assert.equal(page.worldline.index, 1, `应跳到第 1 条世界线，实际 ${page.worldline.index}`)
    assert.equal(page.worldline.total, 2)
  })

  await check('D 回退 + 重说：分叉出第 3 条世界线，旧内容不丢', async () => {
    const firstUser = page.messages[0]
    // 回退到第一条用户消息（不是叶子）
    page = await jumpHead(brain, sessionId, firstUser.id, false)
    assert.equal(page.messages.length, 1, '回退后活动路径只剩第一条消息')
    assert.equal(page.worldline.rewound, true, '应处于回退状态')

    // 从那里重新说一句 → 新分叉
    await chatTurn(brain.url, { userId, sessionId, content: '换个方向问' })
    page = await messagesOf(brain, sessionId)
    assert.equal(page.messages.length, 3, `新分支应有 3 条，实际 ${page.messages.length}`)
    assert.equal(page.messages[1].content, '换个方向问')
    assert.equal(page.worldline.total, 3, `应共 3 条世界线，实际 ${page.worldline.total}`)
    assert.equal(page.worldline.index, 3)

    const allContents = (await worldlinesOf(brain, sessionId)).worldlines.map((w) => w.preview)
    assert.equal(allContents.length, 3)
  })

  await check('E 世界线列表：序号 / 变动率 / 当前标记', async () => {
    const { worldlines } = await worldlinesOf(brain, sessionId)
    assert.equal(worldlines.length, 3)
    assert.deepEqual(worldlines.map((w) => w.index), [1, 2, 3])
    assert.equal(worldlines.filter((w) => w.active).length, 1, '应有且只有一个当前世界线')
    assert.equal(worldlines.find((w) => w.active).index, 3)
    const values = worldlines.map((w) => w.divergence)
    assert.equal(new Set(values).size, 3, `三条世界线的变动率应互不相同：${values}`)
    for (const value of values) assert.ok(value >= 1 && value < 2, `变动率应在 [1,2)：${value}`)
    for (const item of worldlines) assert.ok(item.preview.length > 0, '每条世界线应有预览')
    // 同一条世界线两次查询的变动率必须稳定
    const again = await worldlinesOf(brain, sessionId)
    assert.deepEqual(again.worldlines.map((w) => w.divergence), values, '变动率必须稳定')
  })

  await check('F 跳线清摘要：摘要属于原世界线，跳走后作废', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(brain.dbPath)
    const now = Date.now()
    db.prepare(
      `INSERT INTO session_compactions
         (session_id, summary, through_message_id, through_created_at, messages_summarized, tokens_before, tokens_after, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, '旧世界线的摘要', page.messages[0].id, now, 2, 1000, 100, now)
    db.close()

    const all = await worldlinesOf(brain, sessionId)
    const target = all.worldlines.find((w) => !w.active)
    await jumpHead(brain, sessionId, target.leafId, true)

    const db2 = new DatabaseSync(brain.dbPath)
    const row = db2.prepare('SELECT COUNT(*) AS n FROM session_compactions WHERE session_id = ?').get(sessionId)
    db2.close()
    assert.equal(Number(row.n), 0, '跳线后摘要应被清掉')
  })
} finally {
  await brain.stop()
}

// ---------- G 老库迁移 ----------
await check('G 老库迁移：自动补 parent_id / active_message_id 成一条链', async () => {
  const mock2 = await startMockLlm(() => ({ text: '不应该被调用' }))
  const legacy = await startTestBrain({
    setup: async (dbPath) => {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, feishu_open_id TEXT, bind_code TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, tts_text TEXT, mode TEXT NOT NULL, created_at INTEGER NOT NULL);
      `)
      const now = Date.now()
      db.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run('u1', 'legacy', now)
      db.prepare('INSERT INTO sessions (id, user_id, channel, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('s1', 'u1', 'desktop', '旧会话', now, now)
      const insert = db.prepare('INSERT INTO messages (id, session_id, role, content, tts_text, mode, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      insert.run('m1', 's1', 'user', '旧问题', 'text', now)
      insert.run('m2', 's1', 'assistant', '旧回答', 'text', now + 1)
      insert.run('m3', 's1', 'user', '再问一句', 'text', now + 2)
      db.close()
    }
  })
  try {
    const page = await json(`${legacy.url}/api/sessions/s1/messages`)
    assert.equal(page.messages.length, 3, `迁移后应读到 3 条，实际 ${page.messages.length}`)
    assert.deepEqual(
      page.messages.map((m) => m.parentId),
      [null, 'm1', 'm2'],
      `应回填成一条链，实际 ${JSON.stringify(page.messages.map((m) => m.parentId))}`
    )
    assert.equal(page.worldline.total, 1)
    assert.equal(page.worldline.headId, 'm3', '活动叶应指向最后一条消息')
  } finally {
    await legacy.stop()
    await mock2.close()
  }
})

await mock.close()

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
