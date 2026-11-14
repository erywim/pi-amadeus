import { serve } from '@hono/node-server'
import { automationScheduler } from './automation/scheduler.ts'
import { loadConfig } from './config.ts'
import { createDb } from './db.ts'
import { createHttpApp } from './http/access.ts'
import { AgentStore } from './agents/store.ts'
import { AgentManager } from './agents/manager.ts'
import { CollaborationManager } from './collaboration/manager.ts'
import { RelayManager } from './relay/manager.ts'
import { agentRoutes } from './routes/agents.ts'
import { collaborationRoutes } from './routes/collaboration.ts'
import { relayRoutes } from './routes/relay.ts'
import { mcpManager } from './mcp/manager.ts'
import { platformManager } from './platforms/manager.ts'
import { proactiveScheduler } from './proactive/index.ts'
import { syncMcpPlugins } from './plugins/registry.ts'
import { automationRoutes } from './routes/automations.ts'
import { chatRoutes } from './routes/chat.ts'
import { knowledgeRoutes } from './routes/knowledge.ts'
import { mediaRoutes } from './routes/media.ts'
import { configRoutes } from './routes/config.ts'
import { feishuRoutes } from './routes/feishu.ts'
import { frameRoutes } from './routes/frames.ts'
import { memoryRoutes } from './routes/memories.ts'
import { platformRoutes } from './routes/platforms.ts'
import { pluginRoutes } from './routes/plugins.ts'
import { proactiveRoutes } from './routes/proactive.ts'
import { providerRoutes } from './routes/providers.ts'
import { searchRoutes } from './routes/search.ts'
import { sessionRoutes } from './routes/sessions.ts'
import { skillRoutes } from './routes/skills.ts'
import { statsRoutes } from './routes/stats.ts'
import { sttRoutes } from './routes/stt.ts'
import { toolConfirmRoutes } from './routes/tool-confirm.ts'
import { userRoutes } from './routes/users.ts'
import { voiceRoutes } from './routes/voice.ts'
import { workspaceRoutes } from './routes/workspace.ts'

const cfg = loadConfig()
const app = createHttpApp(cfg)
const db = createDb(cfg.db)
await db.init()
const agentStore = new AgentStore(cfg.db.path)
const agents = new AgentManager(cfg, db, agentStore)
await agents.init()
const collaboration = new CollaborationManager(cfg, agents, agentStore)
const relay = new RelayManager(cfg)

// 拉起已启用的 MCP 插件：npx 首次下载可能较慢，放后台，不阻塞 HTTP 服务可用
void syncMcpPlugins(db)
// 启动已启用的通讯平台适配器（同样后台进行，单个平台失败不影响大脑）
void platformManager.init(cfg, db).catch((error) => {
  console.warn('[platform] 初始化失败：', error instanceof Error ? error.message : error)
})
// 自动化调度器：每 15 秒检查一次到期任务（没有到期任务时只查一次库）
void automationScheduler.init(cfg, db).catch((error) => {
  console.warn('[automation] 调度器启动失败：', error instanceof Error ? error.message : error)
})
// 主动问候：每 60 秒检查一次空闲用户（是否真的问候由 proactive/index.ts 判断）
proactiveScheduler.init(cfg, db)

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'pi-amadeus-brain', time: Date.now(), feishuEnabled: cfg.feishu.enabled })
)

app.route('/api', agentRoutes(agents, agentStore))
app.route('/api', collaborationRoutes(collaboration))
app.route('/api', relayRoutes(relay))
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
app.route('/api', searchRoutes(cfg, db))
app.route('/api', platformRoutes(db))
app.route('/api', memoryRoutes(db))
app.route('/api', knowledgeRoutes(db))
app.route('/api', mediaRoutes(db))
app.route('/api', automationRoutes(db))
app.route('/api', proactiveRoutes(db))
app.route('/api', workspaceRoutes(cfg))
app.route('/api', statsRoutes(db))
app.route('/api', toolConfirmRoutes())
if (cfg.feishu.enabled) {
  app.route('/api', feishuRoutes(cfg, db))
}

// 旧 API 默认仍留在 loopback；需要公网回调时必须显式设置 BRAIN_HOST。
const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  console.log(`[brain] pi-amadeus 大脑服务已启动: ${info.address}:${info.port}`)
  console.log(`[brain] LLM: ${cfg.llm.model} @ ${cfg.llm.baseUrl}`)
  console.log(`[brain] SQLite: ${cfg.db.path}`)
  console.log(`[brain] 飞书: ${cfg.feishu.enabled ? '启用' : '停用'}`)
  console.log(`[brain] Relay: ${cfg.relay.enabled ? '启用' : '停用'}`)
  // 必须等 HTTP 服务真正监听后再拨号 Relay：客户端会把手机请求转发回本机端口。
  void relay.startIfEnabled()
})

// 优雅退出：先停止接受任务与远程订阅，再等待自己启动的执行器退出，最后关库。
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    void (async () => {
      // 先断开 Relay 隧道，再关闭数据库与存储，避免退出期间仍有转发请求落库。
      await relay.shutdown()
      await collaboration.shutdown()
      await agents.shutdown()
      // 先断开 MCP 子进程与平台连接，再关数据库：退出后不留孤儿连接
      mcpManager.closeAll()
      platformManager.stopAll()
      automationScheduler.stop()
      proactiveScheduler.stop()
      agentStore.close()
      await db.close()
    })().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[brain] 退出清理失败：', error)
        process.exit(1)
      }
    )
  })
}
