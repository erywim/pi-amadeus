import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { loadConfig } from './config.ts'
import { createDb } from './db.ts'
import { chatRoutes } from './routes/chat.ts'
import { configRoutes } from './routes/config.ts'
import { feishuRoutes } from './routes/feishu.ts'
import { frameRoutes } from './routes/frames.ts'
import { sessionRoutes } from './routes/sessions.ts'
import { skillRoutes } from './routes/skills.ts'
import { sttRoutes } from './routes/stt.ts'
import { toolConfirmRoutes } from './routes/tool-confirm.ts'
import { userRoutes } from './routes/users.ts'
import { voiceRoutes } from './routes/voice.ts'

const cfg = loadConfig()
const db = createDb(cfg.db)
await db.init()

const app = new Hono()

// 开发期 CORS（渲染层 dev server 517x 跨源访问）
app.use('/api/*', cors({ origin: '*' }))

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'pi-amadeus-brain', time: Date.now(), feishuEnabled: cfg.feishu.enabled })
)

app.route('/api', chatRoutes(cfg, db))
app.route('/api', voiceRoutes(cfg, db))
app.route('/api', sessionRoutes(db))
app.route('/api', userRoutes(db))
app.route('/api', configRoutes(cfg, db))
app.route('/api', sttRoutes(cfg))
app.route('/api', frameRoutes())
app.route('/api', skillRoutes(cfg))
app.route('/api', toolConfirmRoutes())
if (cfg.feishu.enabled) {
  app.route('/api', feishuRoutes(cfg, db))
}

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`[brain] pi-amadeus 大脑服务已启动: http://localhost:${info.port}`)
  console.log(`[brain] LLM: ${cfg.llm.model} @ ${cfg.llm.baseUrl}`)
  console.log(`[brain] SQLite: ${cfg.db.path}`)
  console.log(`[brain] 飞书: ${cfg.feishu.enabled ? '启用' : '停用'}`)
})

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void db.close().finally(() => process.exit(0))
  })
}
