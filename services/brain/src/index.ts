import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { loadConfig } from './config.ts'
import { createDb } from './db.ts'
import { AgentStore } from './agents/store.ts'
import { AgentManager } from './agents/manager.ts'
import { CollaborationManager } from './collaboration/manager.ts'
import { agentRoutes } from './routes/agents.ts'
import { collaborationRoutes } from './routes/collaboration.ts'
import { mcpManager } from './mcp/manager.ts'
import { platformManager } from './platforms/manager.ts'
import { syncMcpPlugins } from './plugins/registry.ts'
import { chatRoutes } from './routes/chat.ts'
import { configRoutes } from './routes/config.ts'
import { feishuRoutes } from './routes/feishu.ts'
import { frameRoutes } from './routes/frames.ts'
import { memoryRoutes } from './routes/memories.ts'
import { platformRoutes } from './routes/platforms.ts'
import { pluginRoutes } from './routes/plugins.ts'
import { providerRoutes } from './routes/providers.ts'
import { sessionRoutes } from './routes/sessions.ts'
import { skillRoutes } from './routes/skills.ts'
import { statsRoutes } from './routes/stats.ts'
import { sttRoutes } from './routes/stt.ts'
import { toolConfirmRoutes } from './routes/tool-confirm.ts'
import { userRoutes } from './routes/users.ts'
import { voiceRoutes } from './routes/voice.ts'

const cfg = loadConfig()
const db = createDb(cfg.db)
await db.init()
const agentStore = new AgentStore(cfg.db.path)
const agents = new AgentManager(cfg, db, agentStore)
await agents.init()
const collaboration = new CollaborationManager(cfg, agents, agentStore)

// 拉起已启用的 MCP 插件：npx 首次下载可能较慢，放后台，不阻塞 HTTP 服务可用
void syncMcpPlugins(db)
// 启动已启用的通讯平台适配器（同样后台进行，单个平台失败不影响大脑）
void platformManager.init(cfg, db).catch((error) => {
  console.warn('[platform] 初始化失败：', error instanceof Error ? error.message : error)
})

const app = new Hono()

// 开发期 CORS（渲染层 dev server 517x 跨源访问）
app.use('/api/*', cors({ origin: '*' }))

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'pi-amadeus-brain', time: Date.now(), feishuEnabled: cfg.feishu.enabled })
)

app.route('/api', agentRoutes(agents, agentStore))
app.route('/api', collaborationRoutes(collaboration))
app.route('/api', chatRoutes(cfg, db))
app.route('/api', voiceRoutes(cfg, db))
app.route('/api', sessionRoutes(db))
app.route('/api', userRoutes(db))
app.route('/api', configRoutes(cfg, db))
app.route('/api', sttRoutes(cfg))
app.route('/api', frameRoutes())
app.route('/api', skillRoutes(cfg))
app.route('/api', pluginRoutes(cfg, db))
app.route('/api', providerRoutes(db))
app.route('/api', platformRoutes(db))
app.route('/api', memoryRoutes(db))
app.route('/api', statsRoutes(db))
app.route('/api', toolConfirmRoutes())
if (cfg.feishu.enabled) {
  app.route('/api', feishuRoutes(cfg, db))
}

// 旧 API 没有远程鉴权，必须留在 loopback；多端连接走单独的受限配对网关。
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: cfg.port }, (info) => {
  console.log(`[brain] pi-amadeus 大脑服务已启动: http://localhost:${info.port}`)
  console.log(`[brain] LLM: ${cfg.llm.model} @ ${cfg.llm.baseUrl}`)
  console.log(`[brain] SQLite: ${cfg.db.path}`)
  console.log(`[brain] 飞书: ${cfg.feishu.enabled ? '启用' : '停用'}`)
})

// 优雅退出：先停止接受任务与远程订阅，再等待自己启动的执行器退出，最后关库。
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    void (async () => {
      await collaboration.shutdown()
      await agents.shutdown()
      mcpManager.closeAll()
      platformManager.stopAll()
      agentStore.close()
      await db.close()
    })().then(() => process.exit(0), (error: unknown) => {
      console.error('[brain] 退出清理失败：', error)
      process.exit(1)
    })
  })
}
