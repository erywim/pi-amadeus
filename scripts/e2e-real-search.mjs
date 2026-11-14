/**
 * 显式真实联网 smoke（会消耗用户配置模型的额度，绝不自动重试429）。
 * 所有用户/会话仅在临时SQLite；搜索使用真实网络，不设置引擎mock或伪造来源。
 * 默认回归跳过此脚本；授权时 E2E_REAL_SEARCH=1 node scripts/e2e-real-search.mjs。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../services/brain/src/config.ts'
import { createDb } from '../services/brain/src/db.ts'
import { runAgentTurn } from '../services/brain/src/agentTurn.ts'
import { readPublicPage } from '../services/brain/src/tools/fetchUrl.ts'

if (process.env.E2E_REAL_SEARCH !== '1') {
  console.log('SKIP real network/model search smoke — set E2E_REAL_SEARCH=1 to authorize external requests and model usage')
  process.exit(2)
}
const cfg = loadConfig()
assert(cfg.llm.apiKey, '真实模型密钥未配置')
const dir = await mkdtemp(join(tmpdir(), 'amadeus-real-search-'))
cfg.db.path = join(dir, 'real.db')
cfg.skills.dir = join(dir, 'skills')
cfg.media.dir = join(dir, 'media')
cfg.workspace.root = dir
cfg.tools.bashCwd = dir
cfg.tools.searchEndpoints = {}
cfg.tools.searchProxy = ''
const db = createDb(cfg.db)
try {
  await db.init()
  const userId = (await db.resolveUser('real-search-smoke')).id
  await db.setUserConfig(userId, {
    provider: { ...cfg.llm, thinkingLevel: 'off', maxTokens: 512 },
    outputLanguage: 'zh',
    tools: { enabled: true },
    systemPrompt: '你是核实来源的助手。必须真实调用search获取搜索结果，不编造来源。只用一句中文和原文URL回答，不再调用其他工具。'
  })
  const events = []
  const turn = runAgentTurn({
    cfg, db, userId, sessionId: 'real-search-smoke', channel: 'webhook', mode: 'text',
    content: '请用search搜索“Node.js releases”，按第一条真实命中给出标题与链接。',
    signal: AbortSignal.timeout(60_000)
  })
  let result
  for (;;) {
    const step = await turn.next()
    if (step.done) { result = step.value; break }
    events.push(step.value)
  }
  const search = events.find((event) => event.type === 'tool_end' && event.toolName === 'search' && !event.isError)
  assert(search, '模型未成功执行search（不作为跳过）')
  assert(search.result.includes('https://'), '真实搜索没有来源URL')
  assert(result.full.includes('https://'), '最终回答未附来源URL')
  console.log(`PASS real model → search → real engine results → cited answer: ${result.full.slice(0, 500)}`)
  console.log(`REAL_USAGE input=${result.usage.input} output=${result.usage.output} total=${result.usage.total}`)
  const page = await readPublicPage('https://nodejs.org/en/about/previous-releases', { maxChars: 1200, signal: AbortSignal.timeout(20_000) })
  assert.match(page.title, /Node.js/)
  assert(page.text.includes('Node.js'))
  console.log(`PASS real fetch_url reader: ${page.title}, source=${page.url}, truncated=${page.truncated}`)
} finally {
  await db.close()
  await rm(dir, { recursive: true, force: true })
}
