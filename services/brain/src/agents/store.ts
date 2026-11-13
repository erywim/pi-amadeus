import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentProfile, AgentTask, AgentTaskEvent } from '@pi-amadeus/shared'

const EVENT_HISTORY = 2000

type JsonRow = { json: string }
type EventRow = { seq: number; task_id: string; type: AgentTaskEvent['type']; data: string; created_at: number }

/** 解析失败必须停下，不能用空对象覆盖仍有价值的原始记录。 */
function parseObject<T>(raw: string): T {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 持久化记录不是 JSON 对象')
  return value as T
}

function eventOf(row: EventRow): AgentTaskEvent {
  return { seq: Number(row.seq), taskId: row.task_id, type: row.type, data: parseObject(row.data), createdAt: Number(row.created_at) }
}

/** 与聊天库共用文件、独立连接；只增加自己的表，不迁移或重写聊天数据。 */
export class AgentStore {
  readonly path: string
  private readonly conn: DatabaseSync
  private readonly listeners = new Set<(userId: string, event: AgentTaskEvent) => void>()
  private schedulerId: string | null = null
  private closed = false

  constructor(path: string) {
    if (!path || path === ':memory:') throw new Error('AgentStore 需要持久化 SQLite 文件路径')
    mkdirSync(dirname(resolve(path)), { recursive: true })
    this.conn = new DatabaseSync(resolve(path))
    this.path = realpathSync(resolve(path))
    try {
      this.conn.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS agent_profiles (
          id TEXT PRIMARY KEY,
          json TEXT NOT NULL CHECK(json_valid(json))
        );
        CREATE TABLE IF NOT EXISTS agent_tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL,
          request_id TEXT,
          remote INTEGER NOT NULL DEFAULT 0,
          json TEXT NOT NULL CHECK(json_valid(json))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_status ON agent_tasks(user_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_request ON agent_tasks(user_id, request_id);
        CREATE TABLE IF NOT EXISTS agent_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL CHECK(json_valid(data)),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_events_user_seq ON agent_events(user_id, seq);
        CREATE TABLE IF NOT EXISTS agent_scheduler_lock (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          owner TEXT NOT NULL,
          pid INTEGER NOT NULL,
          hostname TEXT NOT NULL
        );
      `)
      const columns = this.conn.prepare('PRAGMA table_info(agent_tasks)').all() as { name: string }[]
      if (!columns.some((column) => column.name === 'remote')) this.conn.exec('ALTER TABLE agent_tasks ADD COLUMN remote INTEGER NOT NULL DEFAULT 0')
    } catch (error) {
      this.conn.close()
      throw error
    }
  }

  /** 不依赖过期租约：旧进程仍存活时宁可拒绝第二个调度器，也不重复启动收费任务。 */
  claimScheduler(): void {
    if (this.schedulerId) throw new Error('该 AgentStore 已有调度器')
    const owner = randomUUID()
    this.conn.exec('BEGIN IMMEDIATE')
    try {
      const row = this.conn.prepare('SELECT owner, pid, hostname FROM agent_scheduler_lock WHERE singleton = 1').get() as
        | { owner: string; pid: number; hostname: string }
        | undefined
      if (row) {
        let alive = true
        if (row.hostname === hostname() && Number.isSafeInteger(row.pid) && row.pid > 0) {
          try { process.kill(row.pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
          }
        }
        if (alive) throw new Error('此数据库已有存活的 Agent 调度器')
      }
      this.conn.prepare(`INSERT INTO agent_scheduler_lock(singleton, owner, pid, hostname) VALUES(1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, pid=excluded.pid, hostname=excluded.hostname`)
        .run(owner, process.pid, hostname())
      this.conn.exec('COMMIT')
      // 未占用 → 独占；只认本次随机 owner，旧实例不能释放新实例的锁。
      this.schedulerId = owner
    } catch (error) {
      this.conn.exec('ROLLBACK')
      throw error
    }
  }

  releaseScheduler(): void {
    if (!this.schedulerId || this.closed) return
    this.conn.prepare('DELETE FROM agent_scheduler_lock WHERE singleton = 1 AND owner = ?').run(this.schedulerId)
    // 停机清理完 owned runs 才释放调度权，避免另一个实例过早重启同目录任务。
    this.schedulerId = null
  }

  close(): void {
    if (this.closed) return
    this.releaseScheduler()
    this.listeners.clear()
    this.conn.close()
    // 连接关闭后不再接收订阅或重复执行 close。
    this.closed = true
  }

  listProfiles(): AgentProfile[] {
    return (this.conn.prepare('SELECT json FROM agent_profiles ORDER BY rowid').all() as JsonRow[])
      .map((row) => parseObject<AgentProfile>(row.json))
  }

  getProfile(id: string): AgentProfile | null {
    const row = this.conn.prepare('SELECT json FROM agent_profiles WHERE id = ?').get(id) as JsonRow | undefined
    return row ? parseObject<AgentProfile>(row.json) : null
  }

  saveProfile(profile: AgentProfile): void {
    this.conn.prepare('INSERT INTO agent_profiles(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
      .run(profile.id, JSON.stringify(profile))
  }

  deleteProfile(id: string): void {
    this.conn.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id)
  }

  listTasks(userId: string): AgentTask[] {
    return (this.conn.prepare('SELECT json FROM agent_tasks WHERE user_id = ? ORDER BY rowid DESC').all(userId) as JsonRow[])
      .map((row) => parseObject<AgentTask>(row.json))
  }

  /** 启动恢复必须看到所有用户的队列，而不是仅当前登录者。 */
  listAllTasks(): AgentTask[] {
    return (this.conn.prepare('SELECT json FROM agent_tasks ORDER BY rowid').all() as JsonRow[])
      .map((row) => parseObject<AgentTask>(row.json))
  }

  getTask(id: string): AgentTask | null {
    const row = this.conn.prepare('SELECT json FROM agent_tasks WHERE id = ?').get(id) as JsonRow | undefined
    return row ? parseObject<AgentTask>(row.json) : null
  }

  saveTask(task: AgentTask, requestId?: string): void {
    this.conn.prepare(`INSERT INTO agent_tasks(id, user_id, status, request_id, json) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,
        request_id=COALESCE(excluded.request_id, agent_tasks.request_id), json=excluded.json`)
      .run(task.id, task.userId, task.status, requestId ?? null, JSON.stringify(task))
  }

  isRemoteTask(id: string): boolean {
    const row = this.conn.prepare('SELECT remote FROM agent_tasks WHERE id = ?').get(id) as { remote: number } | undefined
    return row?.remote === 1
  }

  findRequest(userId: string, requestId: string): AgentTask | null {
    const row = this.conn.prepare('SELECT json FROM agent_tasks WHERE user_id = ? AND request_id = ?')
      .get(userId, requestId) as JsonRow | undefined
    return row ? parseObject<AgentTask>(row.json) : null
  }

  private insertEvent(userId: string, taskId: string, type: AgentTaskEvent['type'], data: Record<string, unknown>): AgentTaskEvent {
    const createdAt = Date.now()
    const json = JSON.stringify(data)
    const result = this.conn.prepare('INSERT INTO agent_events(user_id, task_id, type, data, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(userId, taskId, type, json, createdAt)
    this.conn.prepare(`DELETE FROM agent_events WHERE user_id = ? AND seq <= (
      SELECT seq FROM agent_events WHERE user_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
    )`).run(userId, userId, EVENT_HISTORY)
    return { seq: Number(result.lastInsertRowid), taskId, type, data: parseObject(json), createdAt }
  }

  private publish(userId: string, event: AgentTaskEvent): void {
    for (const listener of this.listeners) {
      try { listener(userId, structuredClone(event)) } catch (error) {
        console.warn('[agents] 事件订阅失败，不影响已持久化的执行：', error instanceof Error ? error.message : error)
      }
    }
  }

  addEvent(userId: string, taskId: string, type: AgentTaskEvent['type'], data: Record<string, unknown>): AgentTaskEvent {
    const event = this.insertEvent(userId, taskId, type, data)
    this.publish(userId, event)
    return event
  }

  /** 状态与通知同一个事务提交；客户端重连不会看到事件比任务状态领先。 */
  saveTaskEvent(task: AgentTask, type: AgentTaskEvent['type'], data: Record<string, unknown>, requestId?: string, remote?: boolean): AgentTaskEvent {
    this.conn.exec('BEGIN IMMEDIATE')
    let event: AgentTaskEvent
    try {
      this.saveTask(task, requestId)
      if (remote !== undefined) this.conn.prepare('UPDATE agent_tasks SET remote = ? WHERE id = ?').run(remote ? 1 : 0, task.id)
      event = this.insertEvent(task.userId, task.id, type, data)
      this.conn.exec('COMMIT')
    } catch (error) {
      this.conn.exec('ROLLBACK')
      throw error
    }
    this.publish(task.userId, event)
    return event
  }

  listEvents(userId: string, after: number): AgentTaskEvent[] {
    return (this.conn.prepare('SELECT seq, task_id, type, data, created_at FROM agent_events WHERE user_id = ? AND seq > ? ORDER BY seq')
      .all(userId, after) as EventRow[]).map(eventOf)
  }

  subscribe(listener: (userId: string, event: AgentTaskEvent) => void): () => void {
    if (this.closed) throw new Error('AgentStore 已关闭')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
