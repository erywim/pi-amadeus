import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import type { Channel, TurnMode } from '@pi-amadeus/shared'
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
  // messages
  listMessages(sessionId: string, limit?: number): Promise<MessageRow[]>
  appendMessage(input: {
    id: string
    sessionId: string
    role: 'user' | 'assistant'
    content: string
    ttsText?: string | null
    mode: TurnMode
  }): Promise<void>
  countMessages(sessionId: string): Promise<number>
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
        `)
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
    }
  }

  return db
}
