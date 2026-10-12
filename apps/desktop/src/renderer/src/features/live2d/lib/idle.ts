import type { Live2DEngine } from './live2d-engine'

const rand = (min: number, max: number): number => min + Math.random() * (max - min)

/**
 * 待机动画调度器：决定"何时做什么"，不碰参数。
 * - 眨眼：2-6s 随机间隔（缓动动画在引擎的程序层）
 * - 注视：仅待机时游移，30% 概率看向光标位置
 * - 动作：按回合状态分档——说话 8-14s（表情程序手势；模型自带动作会抢口/眼参数，
 *   说话期间不播）/ 思考暂停 / 待机 15-30s（中性表情用模型自带随机动作，其余用表情手势）
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
    const timer = setTimeout(() => {
      // 回调触发后把自身句柄移出数组：三条链无限续期，数组只应装着未触发的
      const i = this.timers.indexOf(timer)
      if (i >= 0) this.timers.splice(i, 1)
      if (!this.running) return
      fn()
    }, ms)
    this.timers.push(timer)
  }

  /** 眨眼：2-6s 随机间隔，12% 概率连眨 */
  private scheduleBlink(): void {
    this.after(rand(2000, 6000), () => {
      this.engine.blink(Math.random() < 0.12 ? 2 : 1)
      this.scheduleBlink()
    })
  }

  /** 注视：仅待机时游移（说话/思考由程序层接管注视目标），30% 看向光标，偶尔回到正前方 */
  private scheduleGaze(): void {
    this.after(rand(4000, 8000), () => {
      if (!this.engine.getState().busy) {
        const cursor = this.engine.getCursor()
        if (cursor.warm > 0 && Math.random() < 0.3) {
          // 光标 y 向下为正，注视用观察者坐标（上为正）
          this.engine.setGazeImpulse(cursor.x, -cursor.y)
        } else if (Math.random() < 0.25) {
          this.engine.setGazeImpulse(0, 0)
        } else {
          this.engine.setGazeImpulse(rand(-0.9, 0.9), rand(-0.5, 0.5))
        }
      }
      this.scheduleGaze()
    })
  }

  /** 动作：说话 8-14s 手势 / 思考暂停（2s 后重查）/ 待机 15-30s */
  private scheduleMotion(): void {
    const { busy, speaking } = this.engine.getState()
    if (speaking) {
      this.after(rand(8000, 14000), () => {
        this.engine.playTalkingGesture()
        this.scheduleMotion()
      })
      return
    }
    if (busy) {
      // 思考中不跳舞，短暂后重查状态
      this.after(2000, () => this.scheduleMotion())
      return
    }
    this.after(rand(15000, 30000), () => {
      this.engine.playIdleGesture()
      this.scheduleMotion()
    })
  }
}
