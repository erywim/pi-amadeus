/**
 * 网格不透明度覆盖：在 Cubism Core 每帧算完网格（coreModel.update）之后、
 * 渲染器读取之前，把指定网格的不透明度改成我们的值。
 *
 * 用途：脸红不再绑死在某张情绪脸上——粉色脸红（lianhong）原本只随 Param7 出现，
 * Param3 的橙色红晕又过重；覆盖后任何表情都能按需加减脸红。
 *
 * 实现要点（pixi-live2d-display 0.4.0 / Cubism Framework 4-r.4 实测）：
 * - InternalModel.update 在渲染时调用 coreModel.update()，紧接着 renderer.drawModel()
 *   读 drawables.opacities，所以在实例上包一层 update 就能在两者之间插入
 * - opacities / dynamicFlags 是 Core 内存上的视图，下一帧 update 会重新计算，写入不会累积
 * - 不透明度为 0 的网格 Core 会清掉可见位（dynamicFlags bit0），渲染器直接跳过；
 *   强制显示时要同时置位
 */

interface CoreDrawables {
  ids: string[]
  opacities: Float32Array
  dynamicFlags: Uint8Array
}

interface CoreModelLike {
  update(): void
  getModel(): { drawables: CoreDrawables }
  getDrawableIndex(id: string): number
}

const IS_VISIBLE = 1

export class DrawableFx {
  private readonly overrides = new Map<number, number>()
  private readonly indexCache = new Map<string, number>()
  private readonly originalUpdate: () => void

  constructor(private readonly core: CoreModelLike) {
    this.originalUpdate = core.update.bind(core)
    core.update = () => {
      this.originalUpdate()
      this.apply()
    }
  }

  /** 设置网格不透明度覆盖；null 取消覆盖（恢复模型自己算出的值） */
  setOpacity(id: string, opacity: number | null): void {
    const index = this.indexOf(id)
    if (index < 0) return
    if (opacity === null) this.overrides.delete(index)
    else this.overrides.set(index, Math.max(0, Math.min(1, opacity)))
  }

  /** 卸载：去掉实例上的 update，回落到原型方法 */
  destroy(): void {
    this.overrides.clear()
    delete (this.core as Partial<CoreModelLike>).update
  }

  private indexOf(id: string): number {
    let index = this.indexCache.get(id)
    if (index === undefined) {
      index = this.core.getDrawableIndex(id)
      this.indexCache.set(id, index)
    }
    return index
  }

  private apply(): void {
    if (this.overrides.size === 0) return
    const drawables = this.core.getModel().drawables
    for (const [index, opacity] of this.overrides) {
      drawables.opacities[index] = opacity
      const flags = drawables.dynamicFlags[index] ?? 0
      drawables.dynamicFlags[index] = opacity > 0.002 ? flags | IS_VISIBLE : flags & ~IS_VISIBLE
    }
  }
}
