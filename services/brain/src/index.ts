import { serve } from '@hono/node-server'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { automationScheduler } from './automation/scheduler.ts'
import { loadConfig } from './config.ts'
import { createDb } from './db.ts'
import { createHttpApp } from './http/access.ts'
import { mcpManager } from './mcp/manager.ts'
import { platformManager } from './platforms/manager.ts'
import { proactiveScheduler } from './proactive/index.ts'
import { syncMcpPlugins } from './plugins/registry.ts'
import { automationRoutes } from './routes/automations.ts'
import { chatRoutes } from './routes/chat.ts'
import { knowledgeRoutes } from './routes/knowledge.ts'
import { mediaRoutes } from './routes/media.ts'
import { configRoutes } from './routes/config.ts'
import { conversionRoutes } from './routes/conversion.ts'
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
// 开发渲染层与 Electron 打包页需要跨源访问；管理边界先由 createHttpApp 校验。
app.use('/api/*', cors({
  origin: (origin) => origin === 'null'
    ? 'null'
    : origin === 'file://'
      || origin === 'http://localhost:5173'
      || origin === 'http://localhost:5174'
      || origin === 'http://127.0.0.1:5173'
      || origin === 'http://127.0.0.1:5174'
      ? origin
      : undefined,
  exposeHeaders: ['Content-Disposition', 'Content-Length']
}))
// 在 multipart/json 解析前限制转换请求体，避免超大上传先整体读入内存。
app.use('/api/conversion/*', bodyLimit({ maxSize: 128 * 1024 * 1024 }))
const db = createDb(cfg.db)
await db.init()

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

app.route('/api', chatRoutes(cfg, db))
app.route('/api', voiceRoutes(cfg, db))
app.route('/api', sessionRoutes(db))
app.route('/api', userRoutes(db))
app.route('/api', configRoutes(cfg, db))
app.route('/api', conversionRoutes())
app.route('/api', sttRoutes(cfg))
app.route('/api', frameRoutes())
app.route('/api', skillRoutes(cfg))
app.route('/api', pluginRoutes(cfg, db))
app.route('/api', proactiveRoutes(cfg, db))
app.route('/api', providerRoutes(db))
app.route('/api', searchRoutes(cfg, db))
app.route('/api', platformRoutes(db))
app.route('/api', memoryRoutes(db))
app.route('/api', knowledgeRoutes(db))
app.route('/api', mediaRoutes(db))
app.route('/api', automationRoutes(db))
app.route('/api', workspaceRoutes(cfg))
app.route('/api', statsRoutes(db))
app.route('/api', toolConfirmRoutes())
if (cfg.feishu.enabled) {
  app.route('/api', feishuRoutes(cfg, db))
}

// 从未监听进入显式绑定状态：默认 loopback，公网回调需要主动设置 BRAIN_HOST。
serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  console.log(`[brain] pi-amadeus 大脑服务已启动: ${info.address}:${info.port}`)
  console.log(`[brain] LLM: ${cfg.llm.model} @ ${cfg.llm.baseUrl}`)
  console.log(`[brain] SQLite: ${cfg.db.path}`)
  console.log(`[brain] 飞书: ${cfg.feishu.enabled ? '启用' : '停用'}`)
})

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // 先断开 MCP 子进程与平台连接，再关数据库：退出后不留孤儿连接
    mcpManager.closeAll()
    platformManager.stopAll()
    automationScheduler.stop()
    proactiveScheduler.stop()
    void db.close().finally(() => process.exit(0))
  })
}
