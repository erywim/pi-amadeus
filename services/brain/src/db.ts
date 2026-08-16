import pg from 'pg'
import type { Channel, TurnMode } from '@pi-amadeus/shared'
import type { UserConfig } from '@pi-amadeus/shared'
import type { BrainConfig } from './config.ts'

const { Pool } = pg

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
  pool: pg.Pool
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

export function createDb(cfg: BrainConfig['db']): Db {
  const pool = new Pool(cfg)

  const db: Db = {
    pool,

    async init(): Promise<void> {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          feishu_open_id TEXT,
          bind_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS user_configs (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          config JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tts_text TEXT,
          mode TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      `)
    },

    async close(): Promise<void> {
      await pool.end()
    },

    async resolveUser(username) {
      const name = username.trim()
      const existing = await pool.query('SELECT id FROM users WHERE username = $1', [name])
      if (existing.rowCount) return { id: existing.rows[0].id as string }
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      await pool.query(
        'INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
        [id, name]
      )
      const row = await pool.query('SELECT id FROM users WHERE username = $1', [name])
      return { id: row.rows[0]?.id ?? id }
    },

    async getUser(id) {
      const r = await pool.query(
        'SELECT id, username, feishu_open_id, bind_code FROM users WHERE id = $1',
        [id]
      )
      const row = r.rows[0]
      if (!row) return null
      return {
        id: row.id as string,
        username: row.username as string,
        feishuOpenId: (row.feishu_open_id as string | null) ?? null,
        bindCode: (row.bind_code as string | null) ?? null
      }
    },

    async setBindCode(userId, code) {
      await pool.query('UPDATE users SET bind_code = $2 WHERE id = $1', [userId, code])
    },

    async findUserByBindCode(code) {
      const r = await pool.query('SELECT id, username FROM users WHERE bind_code = $1', [code.trim()])
      const row = r.rows[0]
      return row ? { id: row.id as string, username: row.username as string } : null
    },

    async bindFeishu(userId, openId) {
      await pool.query('UPDATE users SET feishu_open_id = $2 WHERE id = $1', [userId, openId])
    },

    async findUserByFeishu(openId) {
      const r = await pool.query('SELECT id, username FROM users WHERE feishu_open_id = $1', [openId])
      const row = r.rows[0]
      return row ? { id: row.id as string, username: row.username as string } : null
    },

    async getUserConfig(userId) {
      const r = await pool.query('SELECT config FROM user_configs WHERE user_id = $1', [userId])
      return (r.rows[0]?.config as UserConfig | undefined) ?? null
    },

    async setUserConfig(userId, config) {
      await pool.query(
        `INSERT INTO user_configs (user_id, config) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [userId, JSON.stringify(config)]
      )
    },

    async listSessions(userId) {
      const r = await pool.query(
        `SELECT s.id, s.user_id, s.channel, s.title,
                EXTRACT(EPOCH FROM s.created_at)::bigint * 1000 AS created_ms,
                EXTRACT(EPOCH FROM s.updated_at)::bigint * 1000 AS updated_ms,
                (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE s.user_id = $1 ORDER BY s.updated_at DESC`,
        [userId]
      )
      return r.rows.map(
        (row): SessionRow => ({
          id: row.id as string,
          userId: row.user_id as string,
          channel: row.channel as Channel,
          title: row.title as string,
          createdAt: Number(row.created_ms),
          updatedAt: Number(row.updated_ms),
          messageCount: Number(row.message_count)
        })
      )
    },

    async getSession(id) {
      const r = await pool.query(
        `SELECT s.id, s.user_id, s.channel, s.title,
                EXTRACT(EPOCH FROM s.created_at)::bigint * 1000 AS created_ms,
                EXTRACT(EPOCH FROM s.updated_at)::bigint * 1000 AS updated_ms,
                (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE s.id = $1`,
        [id]
      )
      const row = r.rows[0]
      if (!row) return null
      return {
        id: row.id as string,
        userId: row.user_id as string,
        channel: row.channel as Channel,
        title: row.title as string,
        createdAt: Number(row.created_ms),
        updatedAt: Number(row.updated_ms),
        messageCount: Number(row.message_count)
      }
    },

    async touchSession(input) {
      await pool.query(
        `INSERT INTO sessions (id, user_id, channel) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
        [input.id, input.userId, input.channel]
      )
    },

    async deleteSession(id) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [id])
    },

    async setSessionTitle(id, title) {
      await pool.query('UPDATE sessions SET title = $2, updated_at = now() WHERE id = $1', [id, title])
    },

    async listMessages(sessionId, limit = 200) {
      const r = await pool.query(
        `SELECT id, session_id, role, content, tts_text, mode,
                EXTRACT(EPOCH FROM created_at)::bigint * 1000 AS created_ms
         FROM (SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2) t
         ORDER BY created_at`,
        [sessionId, limit]
      )
      return r.rows.map(
        (row): MessageRow => ({
          id: row.id as string,
          sessionId: row.session_id as string,
          role: row.role as 'user' | 'assistant',
          content: row.content as string,
          ttsText: (row.tts_text as string | null) ?? null,
          mode: row.mode as TurnMode,
          createdAt: Number(row.created_ms)
        })
      )
    },

    async appendMessage(input) {
      await pool.query(
        `INSERT INTO messages (id, session_id, role, content, tts_text, mode)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.id, input.sessionId, input.role, input.content, input.ttsText ?? null, input.mode]
      )
    },

    async countMessages(sessionId) {
      const r = await pool.query('SELECT COUNT(*)::int AS n FROM messages WHERE session_id = $1', [sessionId])
      return (r.rows[0]?.n as number | undefined) ?? 0
    }
  }

  return db
}
