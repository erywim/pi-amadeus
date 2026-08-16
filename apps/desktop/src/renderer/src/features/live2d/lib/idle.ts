import type { Live2DEngine } from './live2d-engine'

const rand = (min: number, max: number): number => min + Math.random() * (max - min)

/**
 * 待机动画调度器：决定"何时做什么"，不碰参数。
 * - 眨眼：2-6s 随机间隔（缓动动画在引擎的程序层）
 * - 注视：仅待机时游移，30% 概率看向光标位置
 * - 动作：按回合状态分档——说话 8-14s 手势（NORMAL）/ 思考暂停 / 待机 25-45s（IDLE）
 * 呼吸/physics 由框架自动驱动，这里不动。
 */
export class IdleScheduler {
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private running = false

  constructor(private readonly engine: Live2DEngine) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleBlink()
    this.scheduleGaze()
    this.scheduleMotion()
  }

  stop(): void {
    this.running = false
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(
      setTimeout(() => {
        if (!this.running) return
        fn()
      }, ms)
    )
  }

  /** 眨眼：2-6s 随机间隔，12% 概率连眨 */
  private scheduleBlink(): void {
    this.after(rand(2000, 6000), () => {
      this.engine.blink(Math.random() < 0.12 ? 2 : 1)
      this.scheduleBlink()
    })
  }

  /** 注视：仅待机时游移（说话/思考由程序层接管注视目标），30% 看向光标 */
  private scheduleGaze(): void {
    this.after(rand(4000, 8000), () => {
      if (!this.engine.getState().busy) {
        const cursor = this.engine.getCursor()
        if (cursor.warm > 0 && Math.random() < 0.3) {
          this.engine.setGazeImpulse(cursor.x, cursor.y)
        } else {
          this.engine.setGazeImpulse(rand(-0.5, 0.5), rand(-0.25, 0.25))
        }
      }
      this.scheduleGaze()
    })
  }

  /** 动作：说话 8-14s 手势 / 思考暂停（2s 后重查）/ 待机 25-45s */
  private scheduleMotion(): void {
    const { busy, speaking } = this.engine.getState()
    if (speaking) {
      this.after(rand(8000, 14000), () => {
        this.engine.playGesture()
        this.scheduleMotion()
      })
      return
    }
    if (busy) {
      // 思考中不跳舞，短暂后重查状态
      this.after(2000, () => this.scheduleMotion())
      return
    }
    this.after(rand(25000, 45000), () => {
      this.engine.playIdleGesture()
      this.scheduleMotion()
    })
  }
}
