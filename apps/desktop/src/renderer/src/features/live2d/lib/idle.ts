import type { Live2DEngine } from './live2d-engine'

const rand = (min: number, max: number): number => min + Math.random() * (max - min)

/**
 * 待机动画调度器：眨眼 / 注视游移 / 低频随机动作。
 * model3.json 的 EyeBlink 组为空 → 眨眼必须手动驱动参数；
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

  /** 眨眼：2–6s 随机间隔 */
  private scheduleBlink(): void {
    this.after(rand(2000, 6000), () => {
      void this.engine.blink()
      this.scheduleBlink()
    })
  }

  /** 注视：4–8s 间隔在中心小盘内游移，1.2–2.2s 后归零 */
  private scheduleGaze(): void {
    this.after(rand(4000, 8000), () => {
      this.engine.focus(rand(-0.6, 0.6), rand(-0.2, 0.2))
      this.after(rand(1200, 2200), () => {
        this.engine.focus(0, 0)
        this.scheduleGaze()
      })
    })
  }

  /** 随机动作：25–45s 间隔播 random1-5 */
  private scheduleMotion(): void {
    this.after(rand(25000, 45000), () => {
      this.engine.playIdleMotion()
      this.scheduleMotion()
    })
  }
}
