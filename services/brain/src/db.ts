import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import type { Channel, MemoryKind, PlatformKind, PluginKind, TurnMode } from '@pi-amadeus/shared'
import type { UserConfig } from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'

export interface SessionRow {
  id: string
  userId: string
  channel: Channel
  title: string
  createdAt: number
  updatedAt: number
  /** 置顶会话排在列表最前（不改变 updated_at） */
  pinned: boolean
  messageCount: number
}

export interface KnowledgeBaseRow {
  id: string
  userId: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
  docCount: number
  chunkCount: number
}

export interface KnowledgeDocRow {
  id: string
  kbId: string
  name: string
  source: string
  chars: number
  chunks: number
  createdAt: number
}

export interface KnowledgeChunkRow {
  id: string
  kbId: string
  docId: string
  docName: string
  ordinal: number
  content: string
}

export interface AutomationRow {
  id: string
  userId: string
  name: string
  prompt: string
  schedule: 'interval' | 'daily' | 'once'
  intervalMinutes: number
  timeOfDay: string
  runAt: number | null
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: '' | 'running' | 'success' | 'error'
  lastError: string
  lastResult: string
  createdAt: number
  updatedAt: number
}

export interface SessionUsageRow {
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  model: string
}

export interface MessageSearchRow {
  sessionId: string
  sessionTitle: string
  channel: Channel
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface MessageRow {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  ttsText: string | null
  mode: TurnMode
  createdAt: number
}

export interface PluginRow {
  id: string
  kind: PluginKind
  name: string
  enabled: boolean
  config: Record<string, unknown>
  installedAt: number
}

export interface TurnMetricInput {
  sessionId: string
  userId: string
  channel: string
  model: string
  /** 模型服务名（未使用服务列表时为空） */
  provider: string
  startedAt: number
  durationMs: number
  toolCalls: number
  tools: string[]
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface MemoryRow {
  id: string
  userId: string
  content: string
  kind: MemoryKind
  pinned: boolean
  sourceSessionId: string | null
  sourceMessageId: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface AffinityEventRow {
  id: string
  userId: string
  delta: number
  reason: string
  createdAt: number
}

export interface PlatformRow {
  id: string
  kind: PlatformKind
  name: string
  enabled: boolean
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface ProviderRow {
  id: string
  name: string
  baseUrl: string
  /** 仅服务端使用：列表接口不回传 */
  apiKey: string
  model: string
  proxy: string
  enabled: boolean
  active: boolean
  priority: number
  createdAt: number
  updatedAt: number
}

export interface TurnMetricRow extends TurnMetricInput {
  id: string
}

export interface Db {
  init(): Promise<void>
  close(): Promise<void>
  // users
  resolveUser(username: string): Promise<{ id: string }>
  getUser(id: string): Promise<{ id: string; username: string; feishuOpenId: string | null; bindCode: string | null } | null>
  setBindCode(userId: string, code: string): Promise<void>
  findUserByBindCode(code: string): Promise<{ id: string; username: string } | null>
  bindFeishu(userId: string, openId: string): Promise<void>
  findUserByFeishu(openId: string): Promise<{ id: string; username: string } | null>
  // config
  getUserConfig(userId: string): Promise<UserConfig | null>
  setUserConfig(userId: string, config: UserConfig): Promise<void>
  // sessions
  listSessions(userId: string): Promise<SessionRow[]>
  getSession(id: string): Promise<SessionRow | null>
  /** 懒创建（首条消息时）：存在则只刷新 updated_at */
  touchSession(input: { id: string; userId: string; channel: Channel }): Promise<void>
  deleteSession(id: string): Promise<void>
  setSessionTitle(id: string, title: string): Promise<void>
  /** 用户手动重命名：只改标题，不动 updated_at（重命名不是一次活动，不该把会话顶到最前） */
  renameSession(id: string, title: string): Promise<void>
  /** 会话换归属（平台账号绑定到桌面用户后，把该平台的会话交给绑定用户） */
  reassignSession(id: string, userId: string): Promise<void>
  /** 置顶 / 取消置顶；不刷新 updated_at（置顶不是一次活动） */
  setSessionPinned(id: string, pinned: boolean): Promise<void>
  /** 跨会话消息全文搜索（LIKE，最近的在前） */
  searchMessages(userId: string, query: string, limit?: number): Promise<MessageSearchRow[]>
  /** 会话级用量：turn_metrics 真实累计 */
  sessionUsage(sessionId: string): Promise<SessionUsageRow>
  // messages
  listMessages(sessionId: string, limit?: number): Promise<MessageRow[]>
  /** 会话最后一条消息（重新生成时定位用户消息与待替换的助手回复） */
  getLastMessage(sessionId: string): Promise<MessageRow | null>
  deleteMessage(id: string): Promise<void>
  /** 编辑用户消息：只改正文（编辑后重发由调用方截断后续消息再跑回合） */
  updateMessageContent(id: string, content: string): Promise<void>
  /** 截断：删除该消息之后的所有消息（含该消息？不，保留该消息本身） */
  deleteMessagesAfter(sessionId: string, messageId: string): Promise<number>
  appendMessage(input: {
    id: string
    sessionId: string
    role: 'user' | 'assistant'
    content: string
    ttsText?: string | null
    mode: TurnMode
  }): Promise<void>
  countMessages(sessionId: string): Promise<number>
  // auth: 当前登录用户
  getCurrentUser(): Promise<{id: string; username : string} | null>
  setCurrentUser(id:string): Promise<void>
  clearCurrentUser():Promise<void>
  // plugins（插件安装记录，全局共享；skill 的正文仍在 skills 目录）
  listPlugins(): Promise<PluginRow[]>
  getPlugin(id: string): Promise<PluginRow | null>
  upsertPlugin(input: {
    id: string
    kind: PluginKind
    name: string
    enabled: boolean
    config: Record<string, unknown>
  }): Promise<void>
  setPluginEnabled(id: string, enabled: boolean): Promise<void>
  deletePlugin(id: string): Promise<void>
  // turn metrics（数据看板）
  recordTurnMetric(input: TurnMetricInput): Promise<void>
  listTurnMetrics(userId: string, sinceMs: number): Promise<TurnMetricRow[]>
  // memories（长期记忆，真实提取结果）
  listMemories(userId: string, query?: string): Promise<MemoryRow[]>
  countMemories(userId: string): Promise<number>
  addMemory(input: {
    userId: string
    content: string
    kind: MemoryKind
    sourceSessionId?: string | null
    sourceMessageId?: string | null
  }): Promise<MemoryRow>
  updateMemory(
    id: string,
    patch: { content?: string; kind?: MemoryKind; pinned?: boolean }
  ): Promise<MemoryRow | null>
  deleteMemory(id: string): Promise<void>
  touchMemories(ids: string[]): Promise<void>
  // affinity（好感度事件）
  addAffinityEvent(input: { userId: string; delta: number; reason: string }): Promise<void>
  listAffinityEvents(userId: string, sinceMs?: number): Promise<AffinityEventRow[]>
  // providers（多模型服务）
  listProviders(): Promise<ProviderRow[]>
  getProvider(id: string): Promise<ProviderRow | null>
  getActiveProvider(): Promise<ProviderRow | null>
  createProvider(input: {
    name: string
    baseUrl: string
    apiKey: string
    model: string
    proxy: string
    enabled: boolean
    priority: number
  }): Promise<ProviderRow>
  updateProvider(
    id: string,
    patch: {
      name?: string
      baseUrl?: string
      apiKey?: string
      model?: string
      proxy?: string
      enabled?: boolean
      priority?: number
    }
  ): Promise<ProviderRow | null>
  deleteProvider(id: string): Promise<void>
  setActiveProvider(id: string): Promise<void>
  // platforms（通讯平台适配器）
  listPlatforms(): Promise<PlatformRow[]>
  getPlatform(id: string): Promise<PlatformRow | null>
  createPlatform(input: {
    kind: PlatformKind
    name: string
    enabled: boolean
    config: Record<string, unknown>
  }): Promise<PlatformRow>
  updatePlatform(
    id: string,
    patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> }
  ): Promise<PlatformRow | null>
  deletePlatform(id: string): Promise<void>
  findPlatformAccount(platformId: string, externalUserId: string): Promise<{ userId: string } | null>
  // knowledge（知识库）
  listKnowledgeBases(userId: string): Promise<KnowledgeBaseRow[]>
  getKnowledgeBase(id: string): Promise<KnowledgeBaseRow | null>
  createKnowledgeBase(input: { userId: string; name: string; description: string }): Promise<KnowledgeBaseRow>
  updateKnowledgeBase(id: string, patch: { name?: string; description?: string }): Promise<KnowledgeBaseRow | null>
  deleteKnowledgeBase(id: string): Promise<void>
  listKnowledgeDocs(kbId: string): Promise<KnowledgeDocRow[]>
  /** 导入文档：文档行 + 分块在一个事务里写入 */
  addKnowledgeDoc(input: {
    id: string
    kbId: string
    name: string
    source: string
    chunks: { id: string; content: string }[]
  }): Promise<KnowledgeDocRow>
  deleteKnowledgeDoc(id: string): Promise<void>
  /** 检索用：只取指定知识库的分块（带上文档名） */
  listKnowledgeChunks(kbIds: string[], limit?: number): Promise<KnowledgeChunkRow[]>
  // automations（自动化任务）
  listAutomations(userId: string): Promise<AutomationRow[]>
  getAutomation(id: string): Promise<AutomationRow | null>
  createAutomation(input: {
    userId: string
    name: string
    prompt: string
    schedule: 'interval' | 'daily' | 'once'
    intervalMinutes: number
    timeOfDay: string
    runAt: number | null
    enabled: boolean
    nextRunAt: number | null
  }): Promise<AutomationRow>
  updateAutomation(
    id: string,
    patch: {
      name?: string
      prompt?: string
      schedule?: 'interval' | 'daily' | 'once'
      intervalMinutes?: number
      timeOfDay?: string
      runAt?: number | null
      enabled?: boolean
      nextRunAt?: number | null
    }
  ): Promise<AutomationRow | null>
  deleteAutomation(id: string): Promise<void>
  /** 调度器：到期且未在运行的任务 */
  listDueAutomations(now: number): Promise<AutomationRow[]>
  /** 大脑重启时清理上次被中断的 running 状态（否则任务永远不再触发） */
  resetRunningAutomations(): Promise<number>
  /** 任务开始：先置 running，防止同一定时器重入 */
  markAutomationRunning(id: string): Promise<boolean>
  /** 任务结束：写状态、结果与下次触发时间；nextRunAt=null 表示不再触发 */
  finishAutomationRun(input: {
    id: string
    status: 'success' | 'error'
    error: string
    result: string
    nextRunAt: number | null
    enabled?: boolean
  }): Promise<void>
  upsertPlatformAccount(platformId: string, externalUserId: string, userId: string): Promise<void>
}

/** 读取一行并收窄为业务类型（node:sqlite 返回宽泛的 SQLOutputValue 记录） */
function first<T>(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined
}

/** 读取多行并收窄为业务类型 */
function all<T>(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}

function run(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): void {
  db.prepare(sql).run(...params)
}

/**
 * 解析 user_configs.config。
 * 读取/解析失败必须抛错（未知 ≠ 空）：上层若拿到 null 会回落默认配置，
 * 下一次保存就可能覆盖用户原配置。
 */
function parseUserConfig(userId: string, raw: unknown): UserConfig {
  if (typeof raw !== 'string') {
    throw new Error(`用户配置不是文本（user_id=${userId}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`用户配置 JSON 解析失败（user_id=${userId}）：${reason}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`用户配置不是 JSON 对象（user_id=${userId}）`)
  }
  return parsed as UserConfig
}

export function createDb(cfg: BrainConfig['db']): Db {
  let conn: DatabaseSync | null = null

  const getConn = (): DatabaseSync => {
    if (!conn) throw new Error('SQLite 数据库尚未初始化')
    return conn
  }

  const db: Db = {
    async init(): Promise<void> {
      let sqlite: DatabaseSync | null = null
      try {
        mkdirSync(dirname(cfg.path), { recursive: true })
        sqlite = new DatabaseSync(cfg.path, { enableForeignKeyConstraints: true })
        // WAL：读写并发更好；busy_timeout 兜底短暂的写锁竞争。
        // foreign_keys 由构造参数开启，这里显式再设一次，避免未来换构造方式时静默失效。
        sqlite.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          PRAGMA synchronous = NORMAL;
          PRAGMA foreign_keys = ON;

          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            feishu_open_id TEXT,
            bind_code TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS user_configs (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            config TEXT NOT NULL CHECK (json_valid(config)),
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            channel TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tts_text TEXT,
            mode TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

          CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS plugins (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            config TEXT NOT NULL DEFAULT '{}',
            installed_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS turn_metrics (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            model TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT '',
            started_at INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            tool_calls INTEGER NOT NULL DEFAULT 0,
            tools TEXT NOT NULL DEFAULT '[]',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_turn_metrics_user ON turn_metrics(user_id, started_at DESC);

          CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            content TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'fact',
            pinned INTEGER NOT NULL DEFAULT 0,
            source_session_id TEXT,
            source_message_id TEXT,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at DESC);

          CREATE TABLE IF NOT EXISTS affinity_events (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            delta INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_affinity_user ON affinity_events(user_id, created_at DESC);

          CREATE TABLE IF NOT EXISTS providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT NOT NULL,
            model TEXT NOT NULL,
            proxy TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 0,
            priority INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS platforms (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            config TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS platform_accounts (
            platform_id TEXT NOT NULL,
            external_user_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (platform_id, external_user_id)
          );

          CREATE TABLE IF NOT EXISTS knowledge_bases (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user ON knowledge_bases(user_id, created_at ASC);
          CREATE TABLE IF NOT EXISTS knowledge_docs (
            id TEXT PRIMARY KEY,
            kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT '',
            chars INTEGER NOT NULL DEFAULT 0,
            chunks INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb ON knowledge_docs(kb_id, created_at ASC);
          CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id TEXT PRIMARY KEY,
            kb_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            content TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_kb ON knowledge_chunks(kb_id, doc_id, ordinal);

          CREATE TABLE IF NOT EXISTS automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            schedule TEXT NOT NULL,
            interval_minutes INTEGER NOT NULL DEFAULT 60,
            time_of_day TEXT NOT NULL DEFAULT '',
            run_at INTEGER,
            enabled INTEGER NOT NULL DEFAULT 1,
            next_run_at INTEGER,
            last_run_at INTEGER,
            last_status TEXT NOT NULL DEFAULT '',
            last_error TEXT NOT NULL DEFAULT '',
            last_result TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);
          CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id, created_at DESC);
        `)

        // 老库升级：turn_metrics 增加 provider 列（SQLite 没有 IF NOT EXISTS 的 ADD COLUMN）
        const metricColumns = sqlite
          .prepare('PRAGMA table_info(turn_metrics)')
          .all() as unknown as { name: string }[]
        if (!metricColumns.some((column) => column.name === 'provider')) {
          sqlite.exec("ALTER TABLE turn_metrics ADD COLUMN provider TEXT NOT NULL DEFAULT ''")
        }

        // 老库升级：sessions 增加 pinned 列（置顶会话）
        const sessionColumns = sqlite
          .prepare('PRAGMA table_info(sessions)')
          .all() as unknown as { name: string }[]
        if (!sessionColumns.some((column) => column.name === 'pinned')) {
          sqlite.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
        }
        conn = sqlite
      } catch (error) {
        sqlite?.close()
        conn = null
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`无法初始化 SQLite 数据库 ${cfg.path}：${reason}`, { cause: error })
      }
    },

    async close(): Promise<void> {
      // close 不幂等：SIGINT/SIGTERM 或 --watch 重启可能触发两次
      if (!conn) return
      conn.close()
      conn = null
    },

    async resolveUser(username) {
      const sqlite = getConn()
      const name = username.trim()
      const existing = first<{ id: string }>(sqlite, 'SELECT id FROM users WHERE username = ?', [name])
      if (existing) return { id: existing.id }
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      run(
        sqlite,
        'INSERT INTO users (id, username, created_at) VALUES (?, ?, ?) ON CONFLICT(username) DO NOTHING',
        [id, name, Date.now()]
      )
      const row = first<{ id: string }>(sqlite, 'SELECT id FROM users WHERE username = ?', [name])
      return { id: row?.id ?? id }
    },

    async getUser(id) {
      const row = first<{
        id: string
        username: string
        feishu_open_id: string | null
        bind_code: string | null
      }>(getConn(), 'SELECT id, username, feishu_open_id, bind_code FROM users WHERE id = ?', [id])
      if (!row) return null
      return {
        id: row.id,
        username: row.username,
        feishuOpenId: row.feishu_open_id ?? null,
        bindCode: row.bind_code ?? null
      }
    },

    async setBindCode(userId, code) {
      run(getConn(), 'UPDATE users SET bind_code = ? WHERE id = ?', [code, userId])
    },

    async findUserByBindCode(code) {
      const row = first<{ id: string; username: string }>(
        getConn(),
        'SELECT id, username FROM users WHERE bind_code = ?',
        [code.trim()]
      )
      return row ? { id: row.id, username: row.username } : null
    },

    async bindFeishu(userId, openId) {
      run(getConn(), 'UPDATE users SET feishu_open_id = ? WHERE id = ?', [openId, userId])
    },

    async findUserByFeishu(openId) {
      const row = first<{ id: string; username: string }>(
        getConn(),
        'SELECT id, username FROM users WHERE feishu_open_id = ?',
        [openId]
      )
      return row ? { id: row.id, username: row.username } : null
    },

    async getCurrentUser() {
      const row = first<{ id: string; username: string }>(
        getConn(),
        `SELECT u.id, u.username
           FROM app_state a
           JOIN users u ON u.id = a.value
          WHERE a.key = 'current_user_id'`
      )
      return row ? { id: row.id, username: row.username } : null
    },

    async setCurrentUser(id) {
      run(
        getConn(),
        `INSERT INTO app_state (key, value) VALUES ('current_user_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [id]
      )
    },
  
    async clearCurrentUser() {
      run(getConn(), `DELETE FROM app_state WHERE key = 'current_user_id'`)
    },
    async getUserConfig(userId) {
      const row = first<{ config: string }>(
        getConn(),
        'SELECT config FROM user_configs WHERE user_id = ?',
        [userId]
      )
      if (!row) return null
      return parseUserConfig(userId, row.config)
    },

    async setUserConfig(userId, config) {
      run(
        getConn(),
        `INSERT INTO user_configs (user_id, config, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
        [userId, JSON.stringify(config), Date.now()]
      )
    },

    async listSessions(userId) {
      const rows = all<{
        id: string
        user_id: string
        channel: Channel
        title: string
        pinned: number
        created_ms: number
        updated_ms: number
        message_count: number
      }>(
        getConn(),
        `SELECT s.id, s.user_id, s.channel, s.title, s.pinned,
                s.created_at AS created_ms, s.updated_at AS updated_ms,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE s.user_id = ?
         ORDER BY s.pinned DESC, s.updated_at DESC, s.rowid DESC`,
        [userId]
      )
      return rows.map(
        (row): SessionRow => ({
          id: row.id,
          userId: row.user_id,
          channel: row.channel,
          title: row.title,
          pinned: row.pinned === 1,
          createdAt: Number(row.created_ms),
          updatedAt: Number(row.updated_ms),
          messageCount: Number(row.message_count)
        })
      )
    },

    async getSession(id) {
      const row = first<{
        id: string
        user_id: string
        channel: Channel
        title: string
        pinned: number
        created_ms: number
        updated_ms: number
        message_count: number
      }>(
        getConn(),
        `SELECT s.id, s.user_id, s.channel, s.title, s.pinned,
                s.created_at AS created_ms, s.updated_at AS updated_ms,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE s.id = ?`,
        [id]
      )
      if (!row) return null
      return {
        id: row.id,
        userId: row.user_id,
        channel: row.channel,
        title: row.title,
        pinned: row.pinned === 1,
        createdAt: Number(row.created_ms),
        updatedAt: Number(row.updated_ms),
        messageCount: Number(row.message_count)
      }
    },

    async touchSession(input) {
      const now = Date.now()
      run(
        getConn(),
        `INSERT INTO sessions (id, user_id, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
        [input.id, input.userId, input.channel, now, now]
      )
    },

    async deleteSession(id) {
      run(getConn(), 'DELETE FROM sessions WHERE id = ?', [id])
    },

    async setSessionTitle(id, title) {
      // 自动标题只补空标题：用户在首轮标题生成期间手动改名时，
      // 后到的自动标题绝不能覆盖用户设的值（LESSONS：默认值不覆盖用户值）
      run(getConn(), "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ''", [
        title,
        Date.now(),
        id
      ])
    },

    async renameSession(id, title) {
      run(getConn(), 'UPDATE sessions SET title = ? WHERE id = ?', [title, id])
    },

    async reassignSession(id, userId) {
      run(getConn(), 'UPDATE sessions SET user_id = ? WHERE id = ?', [userId, id])
    },

    async setSessionPinned(id, pinned) {
      // 只改 pinned：置顶不是一次活动，不动 updated_at
      run(getConn(), 'UPDATE sessions SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id])
    },

    async searchMessages(userId, query, limit = 30) {
      const keyword = query.trim()
      if (!keyword) return []
      const rows = all<{
        session_id: string
        session_title: string
        channel: Channel
        message_id: string
        role: 'user' | 'assistant'
        content: string
        created_ms: number
      }>(
        getConn(),
        `SELECT s.id AS session_id, s.title AS session_title, s.channel,
                m.id AS message_id, m.role, m.content, m.created_at AS created_ms
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND m.content LIKE ? ESCAPE '\\'
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT ?`,
        [userId, `%${escapeLike(keyword)}%`, Math.min(100, Math.max(1, limit))]
      )
      return rows.map((row) => ({
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        channel: row.channel,
        messageId: row.message_id,
        role: row.role,
        content: row.content,
        createdAt: Number(row.created_ms)
      }))
    },

    async sessionUsage(sessionId) {
      const row = first<{
        turns: number
        input_tokens: number
        output_tokens: number
        total_tokens: number
        model: string
      }>(
        getConn(),
        `SELECT COUNT(*) AS turns,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE((SELECT model FROM turn_metrics WHERE session_id = ? ORDER BY started_at DESC LIMIT 1), '') AS model
         FROM turn_metrics WHERE session_id = ?`,
        [sessionId, sessionId]
      )
      return {
        turns: Number(row?.turns ?? 0),
        inputTokens: Number(row?.input_tokens ?? 0),
        outputTokens: Number(row?.output_tokens ?? 0),
        totalTokens: Number(row?.total_tokens ?? 0),
        model: row?.model ?? ''
      }
    },

    async listMessages(sessionId, limit = 200) {
      const rows = all<{
        id: string
        session_id: string
        role: 'user' | 'assistant'
        content: string
        tts_text: string | null
        mode: TurnMode
        created_ms: number
      }>(
        getConn(),
        `SELECT id, session_id, role, content, tts_text, mode, created_at AS created_ms
         FROM (
           SELECT id, session_id, role, content, tts_text, mode, created_at, rowid AS seq
           FROM messages
           WHERE session_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         ) t
         ORDER BY created_at, seq`,
        [sessionId, limit]
      )
      return rows.map(
        (row): MessageRow => ({
          id: row.id,
          sessionId: row.session_id,
          role: row.role,
          content: row.content,
          ttsText: row.tts_text ?? null,
          mode: row.mode,
          createdAt: Number(row.created_ms)
        })
      )
    },

    async getLastMessage(sessionId) {
      const row = first<{
        id: string
        session_id: string
        role: 'user' | 'assistant'
        content: string
        tts_text: string | null
        mode: TurnMode
        created_ms: number
      }>(
        getConn(),
        `SELECT id, session_id, role, content, tts_text, mode, created_at AS created_ms
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
        [sessionId]
      )
      if (!row) return null
      return {
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        ttsText: row.tts_text ?? null,
        mode: row.mode,
        createdAt: Number(row.created_ms)
      }
    },

    async deleteMessage(id) {
      run(getConn(), 'DELETE FROM messages WHERE id = ?', [id])
    },

    async updateMessageContent(id, content) {
      run(getConn(), 'UPDATE messages SET content = ? WHERE id = ?', [content, id])
    },

    async deleteMessagesAfter(sessionId, messageId) {
      const result = getConn()
        .prepare(
          `DELETE FROM messages
            WHERE session_id = ?
              AND rowid > (SELECT rowid FROM messages WHERE id = ? AND session_id = ?)`
        )
        .run(sessionId, messageId, sessionId) as unknown as { changes?: number }
      return Number(result.changes ?? 0)
    },

    async appendMessage(input) {
      run(
        getConn(),
        `INSERT INTO messages (id, session_id, role, content, tts_text, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.sessionId, input.role, input.content, input.ttsText ?? null, input.mode, Date.now()]
      )
    },

    async countMessages(sessionId) {
      const row = first<{ n: number }>(
        getConn(),
        'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?',
        [sessionId]
      )
      return Number(row?.n ?? 0)
    },

    // ---------- plugins ----------

    async listPlugins() {
      const rows = all<{
        id: string
        kind: PluginKind
        name: string
        enabled: number
        config: string
        installed_at: number
      }>(getConn(), 'SELECT id, kind, name, enabled, config, installed_at FROM plugins ORDER BY installed_at ASC')
      return rows.map(toPluginRow)
    },

    async getPlugin(id) {
      const row = first<{
        id: string
        kind: PluginKind
        name: string
        enabled: number
        config: string
        installed_at: number
      }>(getConn(), 'SELECT id, kind, name, enabled, config, installed_at FROM plugins WHERE id = ?', [id])
      return row ? toPluginRow(row) : null
    },

    async upsertPlugin(input) {
      run(
        getConn(),
        `INSERT INTO plugins (id, kind, name, enabled, config, installed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
           enabled = excluded.enabled, config = excluded.config`,
        [input.id, input.kind, input.name, input.enabled ? 1 : 0, JSON.stringify(input.config), Date.now()]
      )
    },

    async setPluginEnabled(id, enabled) {
      run(getConn(), 'UPDATE plugins SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id])
    },

    async deletePlugin(id) {
      run(getConn(), 'DELETE FROM plugins WHERE id = ?', [id])
    },

    // ---------- turn metrics ----------

    async recordTurnMetric(input) {
      const { randomUUID } = await import('node:crypto')
      run(
        getConn(),
        `INSERT INTO turn_metrics
           (id, session_id, user_id, channel, model, provider, started_at, duration_ms, tool_calls, tools,
            input_tokens, output_tokens, total_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.sessionId,
          input.userId,
          input.channel,
          input.model,
          input.provider,
          input.startedAt,
          input.durationMs,
          input.toolCalls,
          JSON.stringify(input.tools),
          input.inputTokens,
          input.outputTokens,
          input.totalTokens
        ]
      )
    },

    async listTurnMetrics(userId, sinceMs) {
      const rows = all<{
        id: string
        session_id: string
        user_id: string
        channel: string
        model: string
        provider: string
        started_at: number
        duration_ms: number
        tool_calls: number
        tools: string
        input_tokens: number
        output_tokens: number
        total_tokens: number
      }>(
        getConn(),
        `SELECT id, session_id, user_id, channel, model, provider, started_at, duration_ms, tool_calls, tools,
                input_tokens, output_tokens, total_tokens
         FROM turn_metrics
         WHERE user_id = ? AND started_at >= ?
         ORDER BY started_at ASC`,
        [userId, sinceMs]
      )
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        userId: row.user_id,
        channel: row.channel,
        model: row.model,
        provider: row.provider ?? '',
        startedAt: Number(row.started_at),
        durationMs: Number(row.duration_ms),
        toolCalls: Number(row.tool_calls),
        tools: parseStringArray(row.tools),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        totalTokens: Number(row.total_tokens)
      }))
    },

    // ---------- memories ----------

    async listMemories(userId, query) {
      const keyword = (query ?? '').trim()
      const rows = keyword
        ? all<MemoryDbRow>(
            getConn(),
            `SELECT ${MEMORY_COLUMNS} FROM memories
             WHERE user_id = ? AND content LIKE ? ESCAPE '\\'
             ORDER BY pinned DESC, created_at DESC LIMIT 500`,
            [userId, `%${escapeLike(keyword)}%`]
          )
        : all<MemoryDbRow>(
            getConn(),
            `SELECT ${MEMORY_COLUMNS} FROM memories
             WHERE user_id = ?
             ORDER BY pinned DESC, created_at DESC LIMIT 500`,
            [userId]
          )
      return rows.map(toMemoryRow)
    },

    async countMemories(userId) {
      const row = first<{ n: number }>(
        getConn(),
        'SELECT COUNT(*) AS n FROM memories WHERE user_id = ?',
        [userId]
      )
      return Number(row?.n ?? 0)
    },

    async addMemory(input) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      run(
        getConn(),
        `INSERT INTO memories
           (id, user_id, content, kind, pinned, source_session_id, source_message_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)`,
        [id, input.userId, input.content, input.kind, input.sourceSessionId ?? null, input.sourceMessageId ?? null, Date.now()]
      )
      const row = first<MemoryDbRow>(
        getConn(),
        `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`,
        [id]
      )
      return toMemoryRow(row!)
    },

    async updateMemory(id, patch) {
      const sets: string[] = []
      const params: SQLInputValue[] = []
      if (patch.content !== undefined) {
        sets.push('content = ?')
        params.push(patch.content)
      }
      if (patch.kind !== undefined) {
        sets.push('kind = ?')
        params.push(patch.kind)
      }
      if (patch.pinned !== undefined) {
        sets.push('pinned = ?')
        params.push(patch.pinned ? 1 : 0)
      }
      if (sets.length > 0) {
        params.push(id)
        run(getConn(), `UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      const row = first<MemoryDbRow>(
        getConn(),
        `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`,
        [id]
      )
      return row ? toMemoryRow(row) : null
    },

    async deleteMemory(id) {
      run(getConn(), 'DELETE FROM memories WHERE id = ?', [id])
    },

    async touchMemories(ids) {
      if (ids.length === 0) return
      run(
        getConn(),
        `UPDATE memories SET last_used_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
        [Date.now(), ...ids]
      )
    },

    // ---------- affinity ----------

    async addAffinityEvent(input) {
      const { randomUUID } = await import('node:crypto')
      run(
        getConn(),
        'INSERT INTO affinity_events (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), input.userId, input.delta, input.reason, Date.now()]
      )
    },

    async listAffinityEvents(userId, sinceMs = 0) {
      const rows = all<{
        id: string
        user_id: string
        delta: number
        reason: string
        created_at: number
      }>(
        getConn(),
        `SELECT id, user_id, delta, reason, created_at FROM affinity_events
         WHERE user_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 2000`,
        [userId, sinceMs]
      )
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        delta: Number(row.delta),
        reason: row.reason,
        createdAt: Number(row.created_at)
      }))
    },

    // ---------- providers ----------

    async listProviders() {
      const rows = all<ProviderDbRow>(
        getConn(),
        `SELECT ${PROVIDER_COLUMNS} FROM providers
         ORDER BY active DESC, priority ASC, created_at ASC`
      )
      return rows.map(toProviderRow)
    },

    async getProvider(id) {
      const row = first<ProviderDbRow>(
        getConn(),
        `SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ?`,
        [id]
      )
      return row ? toProviderRow(row) : null
    },

    async getActiveProvider() {
      const row = first<ProviderDbRow>(
        getConn(),
        `SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND enabled = 1 LIMIT 1`
      )
      return row ? toProviderRow(row) : null
    },

    async createProvider(input) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      const now = Date.now()
      run(
        getConn(),
        `INSERT INTO providers
           (id, name, base_url, api_key, model, proxy, enabled, active, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          id,
          input.name,
          input.baseUrl,
          input.apiKey,
          input.model,
          input.proxy,
          input.enabled ? 1 : 0,
          input.priority,
          now,
          now
        ]
      )
      return (await db.getProvider(id))!
    },

    async updateProvider(id, patch) {
      const sets: string[] = []
      const params: SQLInputValue[] = []
      const map: [keyof typeof patch, string][] = [
        ['name', 'name'],
        ['baseUrl', 'base_url'],
        ['apiKey', 'api_key'],
        ['model', 'model'],
        ['proxy', 'proxy'],
        ['priority', 'priority']
      ]
      for (const [key, column] of map) {
        const value = patch[key]
        if (typeof value !== 'string' && typeof value !== 'number') continue
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (patch.enabled !== undefined) {
        sets.push('enabled = ?')
        params.push(patch.enabled ? 1 : 0)
      }
      sets.push('updated_at = ?')
      params.push(Date.now())
      params.push(id)
      run(getConn(), `UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, params)
      return db.getProvider(id)
    },

    async deleteProvider(id) {
      run(getConn(), 'DELETE FROM providers WHERE id = ?', [id])
    },

    async setActiveProvider(id) {
      const sqlite = getConn()
      sqlite.exec('BEGIN')
      try {
        run(sqlite, 'UPDATE providers SET active = 0')
        run(sqlite, 'UPDATE providers SET active = 1, updated_at = ? WHERE id = ?', [Date.now(), id])
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },

    // ---------- platforms ----------

    async listPlatforms() {
      const rows = all<PlatformDbRow>(
        getConn(),
        `SELECT ${PLATFORM_COLUMNS} FROM platforms ORDER BY created_at ASC`
      )
      return rows.map(toPlatformRow)
    },

    async getPlatform(id) {
      const row = first<PlatformDbRow>(
        getConn(),
        `SELECT ${PLATFORM_COLUMNS} FROM platforms WHERE id = ?`,
        [id]
      )
      return row ? toPlatformRow(row) : null
    },

    async createPlatform(input) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      const now = Date.now()
      run(
        getConn(),
        `INSERT INTO platforms (id, kind, name, enabled, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, input.kind, input.name, input.enabled ? 1 : 0, JSON.stringify(input.config), now, now]
      )
      return (await db.getPlatform(id))!
    },

    async updatePlatform(id, patch) {
      const sets: string[] = []
      const params: SQLInputValue[] = []
      if (patch.name !== undefined) {
        sets.push('name = ?')
        params.push(patch.name)
      }
      if (patch.enabled !== undefined) {
        sets.push('enabled = ?')
        params.push(patch.enabled ? 1 : 0)
      }
      if (patch.config !== undefined) {
        sets.push('config = ?')
        params.push(JSON.stringify(patch.config))
      }
      sets.push('updated_at = ?')
      params.push(Date.now())
      params.push(id)
      run(getConn(), `UPDATE platforms SET ${sets.join(', ')} WHERE id = ?`, params)
      return db.getPlatform(id)
    },

    async deletePlatform(id) {
      const sqlite = getConn()
      sqlite.exec('BEGIN')
      try {
        run(sqlite, 'DELETE FROM platform_accounts WHERE platform_id = ?', [id])
        run(sqlite, 'DELETE FROM platforms WHERE id = ?', [id])
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },

    async findPlatformAccount(platformId, externalUserId) {
      const row = first<{ user_id: string }>(
        getConn(),
        'SELECT user_id FROM platform_accounts WHERE platform_id = ? AND external_user_id = ?',
        [platformId, externalUserId]
      )
      return row ? { userId: row.user_id } : null
    },

    async upsertPlatformAccount(platformId, externalUserId, userId) {
      run(
        getConn(),
        `INSERT INTO platform_accounts (platform_id, external_user_id, user_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(platform_id, external_user_id) DO UPDATE SET user_id = excluded.user_id`,
        [platformId, externalUserId, userId, Date.now()]
      )
    },

    // ---------- knowledge ----------

    async listKnowledgeBases(userId) {
      const rows = all<KnowledgeBaseDbRow>(
        getConn(),
        `SELECT kb.id, kb.user_id, kb.name, kb.description,
                kb.created_at, kb.updated_at,
                (SELECT COUNT(*) FROM knowledge_docs d WHERE d.kb_id = kb.id) AS doc_count,
                (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.kb_id = kb.id) AS chunk_count
         FROM knowledge_bases kb WHERE kb.user_id = ?
         ORDER BY kb.created_at ASC`,
        [userId]
      )
      return rows.map(toKnowledgeBaseRow)
    },

    async getKnowledgeBase(id) {
      const row = first<KnowledgeBaseDbRow>(
        getConn(),
        `SELECT kb.id, kb.user_id, kb.name, kb.description,
                kb.created_at, kb.updated_at,
                (SELECT COUNT(*) FROM knowledge_docs d WHERE d.kb_id = kb.id) AS doc_count,
                (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.kb_id = kb.id) AS chunk_count
         FROM knowledge_bases kb WHERE kb.id = ?`,
        [id]
      )
      return row ? toKnowledgeBaseRow(row) : null
    },

    async createKnowledgeBase(input) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      const now = Date.now()
      run(
        getConn(),
        `INSERT INTO knowledge_bases (id, user_id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.userId, input.name, input.description, now, now]
      )
      return (await db.getKnowledgeBase(id))!
    },

    async updateKnowledgeBase(id, patch) {
      const sets: string[] = []
      const params: SQLInputValue[] = []
      if (patch.name !== undefined) {
        sets.push('name = ?')
        params.push(patch.name)
      }
      if (patch.description !== undefined) {
        sets.push('description = ?')
        params.push(patch.description)
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?')
        params.push(Date.now())
        params.push(id)
        run(getConn(), `UPDATE knowledge_bases SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      return db.getKnowledgeBase(id)
    },

    async deleteKnowledgeBase(id) {
      const sqlite = getConn()
      sqlite.exec('BEGIN')
      try {
        run(sqlite, 'DELETE FROM knowledge_chunks WHERE kb_id = ?', [id])
        run(sqlite, 'DELETE FROM knowledge_docs WHERE kb_id = ?', [id])
        run(sqlite, 'DELETE FROM knowledge_bases WHERE id = ?', [id])
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },

    async listKnowledgeDocs(kbId) {
      const rows = all<{
        id: string
        kb_id: string
        name: string
        source: string
        chars: number
        chunks: number
        created_at: number
      }>(
        getConn(),
        `SELECT id, kb_id, name, source, chars, chunks, created_at
         FROM knowledge_docs WHERE kb_id = ? ORDER BY created_at ASC`,
        [kbId]
      )
      return rows.map((row) => ({
        id: row.id,
        kbId: row.kb_id,
        name: row.name,
        source: row.source,
        chars: Number(row.chars),
        chunks: Number(row.chunks),
        createdAt: Number(row.created_at)
      }))
    },

    async addKnowledgeDoc(input) {
      const sqlite = getConn()
      const now = Date.now()
      const chars = input.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0)
      sqlite.exec('BEGIN')
      try {
        run(
          sqlite,
          `INSERT INTO knowledge_docs (id, kb_id, name, source, chars, chunks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [input.id, input.kbId, input.name, input.source, chars, input.chunks.length, now]
        )
        for (let index = 0; index < input.chunks.length; index += 1) {
          const chunk = input.chunks[index]!
          run(
            sqlite,
            `INSERT INTO knowledge_chunks (id, kb_id, doc_id, ordinal, content)
             VALUES (?, ?, ?, ?, ?)`,
            [chunk.id, input.kbId, input.id, index, chunk.content]
          )
        }
        run(sqlite, 'UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', [now, input.kbId])
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
      return {
        id: input.id,
        kbId: input.kbId,
        name: input.name,
        source: input.source,
        chars,
        chunks: input.chunks.length,
        createdAt: now
      }
    },

    async deleteKnowledgeDoc(id) {
      const sqlite = getConn()
      const row = first<{ kb_id: string }>(
        sqlite,
        'SELECT kb_id FROM knowledge_docs WHERE id = ?',
        [id]
      )
      if (!row) return
      sqlite.exec('BEGIN')
      try {
        run(sqlite, 'DELETE FROM knowledge_chunks WHERE doc_id = ?', [id])
        run(sqlite, 'DELETE FROM knowledge_docs WHERE id = ?', [id])
        run(sqlite, 'UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', [Date.now(), row.kb_id])
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },

    async listKnowledgeChunks(kbIds, limit = 5000) {
      if (kbIds.length === 0) return []
      const placeholders = kbIds.map(() => '?').join(', ')
      const rows = all<{
        id: string
        kb_id: string
        doc_id: string
        doc_name: string
        ordinal: number
        content: string
      }>(
        getConn(),
        `SELECT c.id, c.kb_id, c.doc_id, d.name AS doc_name, c.ordinal, c.content
         FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id
         WHERE c.kb_id IN (${placeholders})
         ORDER BY c.kb_id, c.doc_id, c.ordinal
         LIMIT ?`,
        [...kbIds, limit]
      )
      return rows.map((row) => ({
        id: row.id,
        kbId: row.kb_id,
        docId: row.doc_id,
        docName: row.doc_name,
        ordinal: Number(row.ordinal),
        content: row.content
      }))
    },

    // ---------- automations ----------

    async listAutomations(userId) {
      const rows = all<AutomationDbRow>(
        getConn(),
        `SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE user_id = ?
         ORDER BY created_at DESC`,
        [userId]
      )
      return rows.map(toAutomationRow)
    },

    async getAutomation(id) {
      const row = first<AutomationDbRow>(
        getConn(),
        `SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE id = ?`,
        [id]
      )
      return row ? toAutomationRow(row) : null
    },

    async createAutomation(input) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      const now = Date.now()
      run(
        getConn(),
        `INSERT INTO automations
           (id, user_id, name, prompt, schedule, interval_minutes, time_of_day, run_at,
            enabled, next_run_at, last_run_at, last_status, last_error, last_result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', '', '', ?, ?)`,
        [
          id,
          input.userId,
          input.name,
          input.prompt,
          input.schedule,
          input.intervalMinutes,
          input.timeOfDay,
          input.runAt,
          input.enabled ? 1 : 0,
          input.nextRunAt,
          now,
          now
        ]
      )
      return (await db.getAutomation(id))!
    },

    async updateAutomation(id, patch) {
      const sets: string[] = []
      const params: SQLInputValue[] = []
      const push = (column: string, value: SQLInputValue): void => {
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (patch.name !== undefined) push('name', patch.name)
      if (patch.prompt !== undefined) push('prompt', patch.prompt)
      if (patch.schedule !== undefined) push('schedule', patch.schedule)
      if (patch.intervalMinutes !== undefined) push('interval_minutes', patch.intervalMinutes)
      if (patch.timeOfDay !== undefined) push('time_of_day', patch.timeOfDay)
      if (patch.runAt !== undefined) push('run_at', patch.runAt)
      if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
      if (patch.nextRunAt !== undefined) push('next_run_at', patch.nextRunAt)
      if (sets.length > 0) {
        push('updated_at', Date.now())
        params.push(id)
        run(getConn(), `UPDATE automations SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      return db.getAutomation(id)
    },

    async deleteAutomation(id) {
      run(getConn(), 'DELETE FROM automations WHERE id = ?', [id])
    },

    async listDueAutomations(now) {
      const rows = all<AutomationDbRow>(
        getConn(),
        `SELECT ${AUTOMATION_COLUMNS} FROM automations
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           AND last_status <> 'running'
         ORDER BY next_run_at ASC`,
        [now]
      )
      return rows.map(toAutomationRow)
    },

    async resetRunningAutomations() {
      const result = getConn()
        .prepare(
          `UPDATE automations
              SET last_status = 'error',
                  last_error = '上次运行被中断（大脑在该任务执行期间退出）',
                  next_run_at = CASE WHEN last_status = 'running' THEN ? ELSE next_run_at END
            WHERE last_status = 'running'`
        )
        .run(Date.now()) as unknown as { changes?: number }
      return Number(result.changes ?? 0)
    },

    async markAutomationRunning(id) {
      const result = getConn()
        .prepare(
          `UPDATE automations SET last_status = 'running', last_error = ''
            WHERE id = ? AND last_status <> 'running'`
        )
        .run(id) as unknown as { changes?: number }
      return Number(result.changes ?? 0) > 0
    },

    async finishAutomationRun(input) {
      const now = Date.now()
      const sets = [
        'last_status = ?',
        'last_error = ?',
        'last_result = ?',
        'last_run_at = ?',
        'next_run_at = ?',
        'updated_at = ?'
      ]
      const params: SQLInputValue[] = [
        input.status,
        input.error,
        input.result,
        now,
        input.nextRunAt,
        now
      ]
      if (input.enabled !== undefined) {
        sets.push('enabled = ?')
        params.push(input.enabled ? 1 : 0)
      }
      params.push(input.id)
      run(getConn(), `UPDATE automations SET ${sets.join(', ')} WHERE id = ?`, params)
    }
  }

  return db
}

const MEMORY_COLUMNS =
  'id, user_id, content, kind, pinned, source_session_id, source_message_id, created_at, last_used_at'
const AUTOMATION_COLUMNS =
  'id, user_id, name, prompt, schedule, interval_minutes, time_of_day, run_at, enabled, ' +
  'next_run_at, last_run_at, last_status, last_error, last_result, created_at, updated_at'

interface KnowledgeBaseDbRow {
  id: string
  user_id: string
  name: string
  description: string
  created_at: number
  updated_at: number
  doc_count: number
  chunk_count: number
}

interface AutomationDbRow {
  id: string
  user_id: string
  name: string
  prompt: string
  schedule: 'interval' | 'daily' | 'once'
  interval_minutes: number
  time_of_day: string
  run_at: number | null
  enabled: number
  next_run_at: number | null
  last_run_at: number | null
  last_status: '' | 'running' | 'success' | 'error'
  last_error: string
  last_result: string
  created_at: number
  updated_at: number
}

function toKnowledgeBaseRow(row: KnowledgeBaseDbRow): KnowledgeBaseRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    docCount: Number(row.doc_count),
    chunkCount: Number(row.chunk_count)
  }
}

function toAutomationRow(row: AutomationDbRow): AutomationRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    intervalMinutes: Number(row.interval_minutes),
    timeOfDay: row.time_of_day,
    runAt: row.run_at === null ? null : Number(row.run_at),
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastResult: row.last_result,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}
const PROVIDER_COLUMNS =
  'id, name, base_url, api_key, model, proxy, enabled, active, priority, created_at, updated_at'
const PLATFORM_COLUMNS = 'id, kind, name, enabled, config, created_at, updated_at'

interface MemoryDbRow {
  id: string
  user_id: string
  content: string
  kind: MemoryKind
  pinned: number
  source_session_id: string | null
  source_message_id: string | null
  created_at: number
  last_used_at: number | null
}

interface ProviderDbRow {
  id: string
  name: string
  base_url: string
  api_key: string
  model: string
  proxy: string
  enabled: number
  active: number
  priority: number
  created_at: number
  updated_at: number
}

function toMemoryRow(row: MemoryDbRow): MemoryRow {
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content,
    kind: row.kind,
    pinned: row.pinned === 1,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at)
  }
}

interface PlatformDbRow {
  id: string
  kind: PlatformKind
  name: string
  enabled: number
  config: string
  created_at: number
  updated_at: number
}

function toPlatformRow(row: PlatformDbRow): PlatformRow {
  let config: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.config)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>
    } else {
      console.warn(`[db] 平台 ${row.id} 的配置不是对象，按空配置展示`)
    }
  } catch (error) {
    console.warn(
      `[db] 平台 ${row.id} 的配置解析失败，按空配置展示（不会回写）：${error instanceof Error ? error.message : error}`
    )
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled === 1,
    config,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function toProviderRow(row: ProviderDbRow): ProviderRow {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    proxy: row.proxy,
    enabled: row.enabled === 1,
    active: row.active === 1,
    priority: Number(row.priority),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/** LIKE 查询里的通配符转义（用户搜索词里的 % 和 _ 按字面量匹配） */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** plugins.config 是用户装的插件配置；解析失败按空对象处理并告警（不覆盖、不回写） */
function toPluginRow(row: {
  id: string
  kind: PluginKind
  name: string
  enabled: number
  config: string
  installed_at: number
}): PluginRow {
  let config: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.config)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>
    } else {
      console.warn(`[db] 插件 ${row.id} 的配置不是对象，按空配置展示`)
    }
  } catch (error) {
    console.warn(
      `[db] 插件 ${row.id} 的配置解析失败，按空配置展示（不会回写）：${error instanceof Error ? error.message : error}`
    )
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled === 1,
    config,
    installedAt: Number(row.installed_at)
  }
}

function parseStringArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
