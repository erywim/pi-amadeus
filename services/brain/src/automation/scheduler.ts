import type { AutomationRow } from '../db.ts'
import { runAgentTurn, type AgentTurnResult } from '../agentTurn.ts'
import type { BrainConfig } from '../config.ts'
import { finishTurn } from '../conversation.ts'
import type { Db } from '../db.ts'
import { recordTurnMetric } from '../metrics.ts'
import { computeNextRun } from './schedule.ts'

/** 结果正文落库上限：列表里要能展开看，但不能把整篇长文塞进每次列表响应 */
const RESULT_LIMIT = 8000
const TICK_MS = 15_000

/**
 * 自动化调度器：每 15 秒查一次到期任务。
 * - 单任务串行：数据库把 last_status 先置 running，避免 15 秒 tick 重入
 * - 单任务失败不影响其它任务
 * - 每次运行就是一个真实 agent 回合：落消息、落指标、写回结果
 */
class AutomationScheduler {
  private cfg: BrainConfig | null = null
  private db: Db | null = null
  private timer: NodeJS.Timeout | null = null
  private running = new Set<string>()

  async init(cfg: BrainConfig, db: Db): Promise<void> {
    this.cfg = cfg
    this.db = db
    const stale = await db.resetRunningAutomations()
    if (stale > 0) console.warn(`[automation] 清理了 ${stale} 个被中断的任务状态`)
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    // 启动后立刻查一次：大脑停机期间到期的任务不用再等一个 tick
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 手动「立即运行」：不改变既定的下次触发时间 */
  async runNow(id: string): Promise<boolean> {
    if (!this.db || !this.cfg) return false
    if (this.running.has(id)) return false
    const row = await this.db.getAutomation(id)
    if (!row) return false
    const started = await this.db.markAutomationRunning(id)
    if (!started) return false
    void this.execute(row, true)
    return true
  }

  private async tick(): Promise<void> {
    if (!this.db || !this.cfg) return
    try {
      const due = await this.db.listDueAutomations(Date.now())
      for (const row of due) {
        if (this.running.has(row.id)) continue
        const started = await this.db.markAutomationRunning(row.id)
        if (!started) continue
        void this.execute(row, false)
      }
    } catch (error) {
      console.warn('[automation] 调度失败：', error instanceof Error ? error.message : error)
    }
  }

  private async execute(row: AutomationRow, manual: boolean): Promise<void> {
    if (!this.db || !this.cfg) return
    const db = this.db
    const cfg = this.cfg
    this.running.add(row.id)
    const sessionId = `automation-${row.id}`
    const startedAt = Date.now()
    let result = ''
    let status: 'success' | 'error' = 'success'
    let errorText = ''

    try {
      const run = runAgentTurn({
        cfg,
        db,
        userId: row.userId,
        sessionId,
        channel: 'automation',
        mode: 'text',
        content: row.prompt,
        signal: AbortSignal.timeout(10 * 60_000),
        temperature: 0.7
      })
      let full = ''
      let turn: AgentTurnResult | null = null
      for (;;) {
        const step = await run.next()
        if (step.done) {
          turn = step.value
          break
        }
        if (step.value.type === 'delta') full += step.value.delta
      }
      if (!turn) throw new Error('回合没有返回结果')
      result = turn.full || full
      if (!result.trim()) throw new Error('LLM 返回为空')
      await finishTurn(db, {
        sessionId,
        userId: row.userId,
        channel: 'automation',
        mode: 'text',
        content: result,
        ttsText: null,
        target: turn.target,
        userText: row.prompt,
        toolCalls: turn.toolCalls
      })
      await recordTurnMetric(db, {
        sessionId,
        userId: row.userId,
        channel: 'automation',
        startedAt,
        model: turn.target.model,
        providerName: turn.target.providerName,
        usage: turn.usage,
        toolCalls: turn.toolCalls,
        toolNames: turn.toolNames
      })
    } catch (error) {
      status = 'error'
      errorText = error instanceof Error ? error.message : String(error)
      console.warn(`[automation] 任务「${row.name}」失败：`, errorText)
    } finally {
      this.running.delete(row.id)
    }

    // 下次触发：到点触发按调度重算；手动运行保持原有下次时间
    let nextRunAt = manual ? row.nextRunAt : null
    if (!manual) {
      if (row.schedule === 'once') {
        nextRunAt = null
      } else {
        nextRunAt = computeNextRun({
          schedule: row.schedule,
          intervalMinutes: row.intervalMinutes,
          timeOfDay: row.timeOfDay,
          runAt: row.runAt
        })
        // 运行超时导致算出的下一次仍在过去：继续往后排，避免补跑风暴
        if (nextRunAt !== null && nextRunAt <= Date.now() && row.schedule === 'interval') {
          nextRunAt = Date.now() + Math.max(1, row.intervalMinutes) * 60_000
        }
      }
    }
    const disableOnce = row.schedule === 'once' && !manual
    await db
      .finishAutomationRun({
        id: row.id,
        status,
        error: errorText.slice(0, 2000),
        result: result.slice(0, RESULT_LIMIT),
        nextRunAt,
        ...(disableOnce ? { enabled: false } : {})
      })
      .catch((error) => {
        console.warn('[automation] 写回运行结果失败：', error instanceof Error ? error.message : error)
      })
  }
}

/** 进程级单例（与 platformManager 同前提：一个 brain 一套定时任务） */
export const automationScheduler = new AutomationScheduler()
