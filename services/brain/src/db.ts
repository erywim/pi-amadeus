import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import type { Channel, MemoryKind, PluginKind, TurnMode } from '@pi-amadeus/shared'
import type { UserConfig } from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'

export interface SessionRow {
  id: string
  userId: string
  channel: Channel
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
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
  // messages
  listMessages(sessionId: string, limit?: number): Promise<MessageRow[]>
  /** 会话最后一条消息（重新生成时定位用户消息与待替换的助手回复） */
  getLastMessage(sessionId: string): Promise<MessageRow | null>
  deleteMessage(id: string): Promise<void>
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
        `)

        // 老库升级：turn_metrics 增加 provider 列（SQLite 没有 IF NOT EXISTS 的 ADD COLUMN）
        const metricColumns = sqlite
          .prepare('PRAGMA table_info(turn_metrics)')
          .all() as unknown as { name: string }[]
        if (!metricColumns.some((column) => column.name === 'provider')) {
          sqlite.exec("ALTER TABLE turn_metrics ADD COLUMN provider TEXT NOT NULL DEFAULT ''")
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
        created_ms: number
        updated_ms: number
        message_count: number
      }>(
        getConn(),
        `SELECT s.id, s.user_id, s.channel, s.title,
                s.created_at AS created_ms, s.updated_at AS updated_ms,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE s.user_id = ?
         ORDER BY s.updated_at DESC, s.rowid DESC`,
        [userId]
      )
      return rows.map(
        (row): SessionRow => ({
          id: row.id,
          userId: row.user_id,
          channel: row.channel,
          title: row.title,
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
        created_ms: number
        updated_ms: number
        message_count: number
      }>(
        getConn(),
        `SELECT s.id, s.user_id, s.channel, s.title,
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
      run(getConn(), 'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [title, Date.now(), id])
    },

    async renameSession(id, title) {
      run(getConn(), 'UPDATE sessions SET title = ? WHERE id = ?', [title, id])
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
    }
  }

  return db
}

const MEMORY_COLUMNS =
  'id, user_id, content, kind, pinned, source_session_id, source_message_id, created_at, last_used_at'
const PROVIDER_COLUMNS =
  'id, name, base_url, api_key, model, proxy, enabled, active, priority, created_at, updated_at'

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
