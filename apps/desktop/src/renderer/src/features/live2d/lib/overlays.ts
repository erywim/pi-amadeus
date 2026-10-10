import * as PIXI from 'pixi.js'
import type { Live2DModel } from 'pixi-live2d-display/cubism4'
import { DRAWABLES } from './model-params'

/**
 * 漫画符号层：眼泪、汗滴、青筋、阴影线、问号/感叹号、闪光、冒烟、省略号、ZZZ、脸红斜线。
 *
 * 模型本身没有这些部件（加部件需要改模型），这里用 Pixi 矢量图形画在模型容器里：
 * - 作为 Live2DModel 的子节点，自动继承形象的缩放/位移，绘制顺序在模型之上
 * - 每帧从网格顶点取锚点（脸、眼、脸颊），符号跟着头部转动、歪头
 * - 尺寸按脸宽 F 取比例，形象缩放后符号同比例变化
 * 网格顶点在渲染时才更新，这里读到的是上一帧的位置（相差 1 帧，肉眼不可见）。
 */

export type OverlayKind =
  | 'tears'
  | 'sweat'
  | 'vein'
  | 'gloom'
  | 'question'
  | 'exclaim'
  | 'sparkle'
  | 'steam'
  | 'ellipsis'
  | 'zzz'
  | 'blushLines'

/** 一次性符号的显示时长（秒）；其余随情绪持续显示 */
const TRANSIENT: Partial<Record<OverlayKind, number>> = {
  question: 3.2,
  exclaim: 1.8,
  ellipsis: 3.6,
  sparkle: 4.2
}

const FADE_K = 7

interface Pt {
  x: number
  y: number
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 锚点：全部在模型局部坐标（Live2DModel 子节点坐标系） */
export interface Anchors {
  face: Rect
  /** 脸宽：符号尺寸基准 */
  F: number
  eyeL: Rect
  eyeR: Rect
  cheekL: Pt
  cheekR: Pt
  /** 头部侧倾（弧度，两眼连线角度） */
  roll: number
}

interface CoreLike {
  getDrawableIndex(id: string): number
  getDrawableVertices(index: number): Float32Array
}

interface InternalLike {
  coreModel: unknown
  localTransform: PIXI.Matrix
  pixelsPerUnit: number
  originalWidth: number
  originalHeight: number
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min)

/** 统一的描边样式（圆头圆角） */
function stroke(g: PIXI.Graphics, width: number, color: number, alpha: number): void {
  g.lineStyle({ width, color, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND })
}

/** 水滴形：尖头朝上，底部圆心在 (0, cy)，整体高 h、宽 w，中心在原点 */
function drawDrop(g: PIXI.Graphics, w: number, h: number): void {
  const r = w / 2
  const cy = h / 2 - r
  g.moveTo(0, -h / 2)
  g.bezierCurveTo(w * 0.12, -h * 0.22, r, cy - r * 0.9, r, cy)
  g.arc(0, cy, r, 0, Math.PI)
  g.bezierCurveTo(-r, cy - r * 0.9, -w * 0.12, -h * 0.22, 0, -h / 2)
  g.closePath()
}

function textStyle(size: number, fill: number, strokeColor: number): PIXI.TextStyle {
  return new PIXI.TextStyle({
    fontFamily: ['Arial Black', 'Helvetica Neue', 'PingFang SC', 'sans-serif'],
    fontSize: size,
    fontWeight: '900',
    fill,
    stroke: strokeColor,
    strokeThickness: Math.max(2, size * 0.12),
    lineJoin: 'round'
  })
}

/** 单个符号：自带容器、淡入淡出与计时 */
abstract class Overlay {
  readonly root = new PIXI.Container()
  alpha = 0
  target = 0
  t = 0
  /** 一次性符号的剩余显示时间（秒），null = 持续 */
  remaining: number | null = null

  constructor(parent: PIXI.Container) {
    this.root.visible = false
    parent.addChild(this.root)
  }

  show(duration: number | null): void {
    if (this.target === 0 || duration !== null) this.t = 0
    this.target = 1
    this.remaining = duration
  }

  hide(): void {
    this.target = 0
    this.remaining = null
  }

  /** 推进；返回本帧是否需要绘制 */
  step(dt: number): boolean {
    if (this.remaining !== null) {
      this.remaining -= dt
      if (this.remaining <= 0) this.hide()
    }
    this.alpha += (this.target - this.alpha) * (1 - Math.exp(-FADE_K * dt))
    if (this.target === 0 && this.alpha < 0.01) {
      this.alpha = 0
      this.root.visible = false
      return false
    }
    this.t += dt
    this.root.visible = true
    this.root.alpha = this.alpha
    return true
  }

  abstract draw(a: Anchors, dt: number): void
}

/** 偏移向量随头部侧倾旋转后加到锚点上 */
function at(a: Anchors, base: Pt, dx: number, dy: number): Pt {
  const c = Math.cos(a.roll)
  const s = Math.sin(a.roll)
  return { x: base.x + dx * c - dy * s, y: base.y + dx * s + dy * c }
}

const center = (r: Rect): Pt => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })

// —— 各符号 ——

/** 眼泪：下眼睑积泪 + 周期性滑落的泪滴 + 淡泪痕 */
class Tears extends Overlay {
  private readonly g = new PIXI.Graphics()
  private drops: Array<{ side: 0 | 1; t: number; life: number }> = []
  private nextDrop: [number, number] = [0.2, 0.6]

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors, dt: number): void {
    const g = this.g
    const F = a.F
    g.clear()
    for (const side of [0, 1] as const) {
      this.nextDrop[side] -= dt
      if (this.target > 0 && this.nextDrop[side] <= 0) {
        this.drops.push({ side, t: 0, life: rand(1.0, 1.4) })
        this.nextDrop[side] = rand(0.55, 1.0)
      }
    }
    const bead = (side: 0 | 1): Pt => {
      const eye = side === 0 ? a.eyeL : a.eyeR
      const c = center(eye)
      const outward = side === 0 ? -1 : 1
      return at(a, { x: c.x, y: eye.y1 }, outward * (eye.x1 - eye.x0) * 0.18, -F * 0.005)
    }
    for (const side of [0, 1] as const) {
      const p = bead(side)
      // 泪痕
      stroke(g, F * 0.02, 0x9fd3ff, 0.45)
      g.moveTo(p.x, p.y)
      const end = at(a, p, 0, F * 0.3)
      g.quadraticCurveTo(p.x + (end.x - p.x) * 0.3, (p.y + end.y) / 2, end.x, end.y)
      g.lineStyle(0)
      // 积泪
      g.lineStyle(F * 0.004, 0x5aa9e6, 0.9)
      g.beginFill(0xbfe6ff, 0.92)
      g.drawEllipse(p.x, p.y, F * 0.06, F * 0.024)
      g.endFill()
      g.lineStyle(0)
      g.beginFill(0xffffff, 0.95)
      g.drawCircle(p.x - F * 0.018, p.y - F * 0.006, F * 0.008)
      g.endFill()
    }
    for (const d of this.drops) d.t += dt
    this.drops = this.drops.filter((d) => d.t < d.life)
    for (const d of this.drops) {
      const p = bead(d.side)
      const k = d.t / d.life
      const fall = F * 0.34 * k * k + F * 0.025
      const q = at(a, p, 0, fall)
      const alpha = k < 0.75 ? 1 : (1 - k) / 0.25
      const w = F * 0.048
      const h = F * 0.068
      g.lineStyle(F * 0.004, 0x5aa9e6, alpha)
      g.beginFill(0xbfe6ff, 0.92 * alpha)
      g.drawEllipse(q.x, q.y, w / 2, h / 2)
      g.endFill()
      g.lineStyle(0)
      g.beginFill(0xffffff, alpha)
      g.drawCircle(q.x - w * 0.18, q.y - h * 0.15, w * 0.13)
      g.endFill()
    }
  }
}

/** 汗滴：太阳穴旁的大水滴，轻微下滑晃动 */
class Sweat extends Overlay {
  private readonly g = new PIXI.Graphics()

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors): void {
    const g = this.g
    const F = a.F
    const pop = Math.min(1, this.t / 0.25)
    const scale = 0.7 + 0.3 * pop + 0.08 * Math.sin(pop * Math.PI)
    const slide = ((this.t * 0.35) % 1) * F * 0.02
    const base = at(a, { x: a.face.x1, y: a.face.y0 }, -F * 0.02, F * 0.2 + slide)
    const w = F * 0.13 * scale
    const h = F * 0.21 * scale
    g.clear()
    g.position.set(base.x, base.y)
    g.rotation = a.roll + 0.12
    g.lineStyle(F * 0.009, 0x3f8fd2, 1)
    g.beginFill(0xd6f1ff, 0.96)
    drawDrop(g, w, h)
    g.endFill()
    g.lineStyle(0)
    g.beginFill(0xffffff, 0.95)
    g.drawEllipse(-w * 0.17, h * 0.12, w * 0.1, h * 0.17)
    g.endFill()
  }
}

/** 青筋（💢）：四段弧形，按心跳节奏鼓动 */
class Vein extends Overlay {
  private readonly g = new PIXI.Graphics()

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors): void {
    const g = this.g
    const F = a.F
    const beat = Math.pow(Math.max(0, Math.sin(this.t * Math.PI * 2 * 1.4)), 6)
    const pop = Math.min(1, this.t / 0.2)
    const s = F * 0.075 * (0.6 + 0.4 * pop) * (1 + 0.16 * beat)
    const p = at(a, { x: a.face.x1, y: a.face.y0 }, -F * 0.16, F * 0.1)
    g.clear()
    g.position.set(p.x, p.y)
    g.rotation = a.roll + 0.2
    stroke(g, F * 0.028, 0xd7262b, 1)
    for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
      g.moveTo(sx * s * 0.25, sy * s * 1.05)
      g.quadraticCurveTo(sx * s * 0.22, sy * s * 0.22, sx * s * 1.05, sy * s * 0.25)
    }
  }
}

/** 阴影线：从额头垂到眼睛的竖线，上浓下淡，缓慢伸缩 */
class Gloom extends Overlay {
  private readonly g = new PIXI.Graphics()
  private readonly lines = Array.from({ length: 13 }, (_, i) => ({
    u: (i + 0.5) / 13 + rand(-0.015, 0.015),
    len: rand(0.65, 1),
    w: rand(0.7, 1.3),
    phase: rand(0, Math.PI * 2)
  }))

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors): void {
    const g = this.g
    const F = a.F
    // 以眼睛定位：脸部网格上沿伸进头发里，不能拿来当额头
    const eyeTop = Math.min(a.eyeL.y0, a.eyeR.y0)
    const eyeBottom = Math.max(a.eyeL.y1, a.eyeR.y1)
    const top = eyeTop - F * 0.38
    const bottom = eyeBottom + F * 0.02
    const left = a.eyeL.x0 - F * 0.03
    const right = a.eyeR.x1 + F * 0.03
    const width = right - left
    g.clear()
    for (const l of this.lines) {
      const len = (bottom - top) * l.len * (0.88 + 0.12 * Math.sin(this.t * 1.5 + l.phase))
      const x = left + width * l.u
      const segs = 5
      for (let k = 0; k < segs; k++) {
        const p0 = at(a, { x, y: top + (len * k) / segs }, 0, 0)
        const p1 = at(a, { x, y: top + (len * (k + 1)) / segs }, 0, 0)
        stroke(g, F * 0.011 * l.w, 0x3d2f7a, 0.85 - (0.55 * k) / (segs - 1))
        g.moveTo(p0.x, p0.y)
        g.lineTo(p1.x, p1.y)
      }
    }
  }
}

/** 文字符号的公共部分：头部右上方，弹出后轻微漂浮 */
abstract class Glyph extends Overlay {
  protected readonly text: PIXI.Text

  constructor(parent: PIXI.Container, content: string, fill: number, strokeColor: number) {
    super(parent)
    this.text = new PIXI.Text(content, textStyle(120, fill, strokeColor))
    this.text.anchor.set(0.5)
    this.root.addChild(this.text)
  }

  protected place(a: Anchors, dx: number, dy: number, size: number, tilt: number): void {
    const F = a.F
    const p = at(a, { x: a.face.x1, y: a.face.y0 }, dx * F, dy * F)
    this.text.position.set(p.x, p.y)
    this.text.rotation = a.roll + tilt
    this.text.scale.set((size * F) / 120)
  }
}

class Question extends Glyph {
  constructor(parent: PIXI.Container) {
    super(parent, '?', 0xffffff, 0x26262b)
  }

  draw(a: Anchors): void {
    const pop = Math.min(1, this.t / 0.22)
    const over = 1 + 0.25 * Math.sin(pop * Math.PI)
    this.place(a, 0.2, 0.02 + Math.sin(this.t * 2.2) * 0.02, 0.3 * pop * over, 0.18 + Math.sin(this.t * 1.4) * 0.08)
  }
}

class Exclaim extends Glyph {
  private readonly lines = new PIXI.Graphics()

  constructor(parent: PIXI.Container) {
    super(parent, '!', 0xffe066, 0x26262b)
    this.root.addChildAt(this.lines, 0)
  }

  draw(a: Anchors): void {
    const F = a.F
    const pop = Math.min(1, this.t / 0.18)
    const over = 1 + 0.35 * Math.sin(pop * Math.PI)
    const shake = this.t < 0.4 ? Math.sin(this.t * 60) * 0.008 : 0
    this.place(a, 0.18 + shake, 0.0, 0.36 * pop * over, 0.12)
    // 惊吓的放射短线
    const c = this.text.position
    const g = this.lines
    g.clear()
    stroke(g, F * 0.012, 0xffe066, 0.9 * pop)
    for (const ang of [-2.2, -1.6, -1.0]) {
      const r0 = F * 0.17
      const r1 = F * 0.25
      g.moveTo(c.x + Math.cos(ang + a.roll) * r0, c.y + Math.sin(ang + a.roll) * r0)
      g.lineTo(c.x + Math.cos(ang + a.roll) * r1, c.y + Math.sin(ang + a.roll) * r1)
    }
  }
}

/** 闪光：头部周围几颗四角星依次闪烁 */
class Sparkle extends Overlay {
  private readonly g = new PIXI.Graphics()
  private readonly stars = [
    { dx: -0.62, dy: 0.05, s: 1, ph: 0 },
    { dx: 0.66, dy: -0.05, s: 1.2, ph: 1.7 },
    { dx: -0.5, dy: 0.5, s: 0.7, ph: 3.1 },
    { dx: 0.58, dy: 0.45, s: 0.8, ph: 4.4 },
    { dx: 0.36, dy: -0.32, s: 0.65, ph: 2.4 }
  ]

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors): void {
    const g = this.g
    const F = a.F
    const c = center(a.face)
    g.clear()
    for (const st of this.stars) {
      const tw = Math.pow(Math.sin(this.t * 3.2 + st.ph) * 0.5 + 0.5, 2)
      const r = F * 0.085 * st.s * (0.45 + 0.55 * tw)
      const p = at(a, c, st.dx * F, st.dy * F)
      g.lineStyle(0)
      g.beginFill(0xfff3b8, 0.35 + 0.65 * tw)
      const k = r * 0.22
      g.drawPolygon([p.x, p.y - r, p.x + k, p.y - k, p.x + r, p.y, p.x + k, p.y + k, p.x, p.y + r, p.x - k, p.y + k, p.x - r, p.y, p.x - k, p.y - k])
      g.endFill()
      g.beginFill(0xffffff, 0.9 * tw)
      g.drawCircle(p.x, p.y, r * 0.16)
      g.endFill()
    }
  }
}

/** 冒烟：从两侧太阳穴不断冒出、向外上方飘散变大的白烟 */
class Steam extends Overlay {
  private readonly g = new PIXI.Graphics()
  private puffs: Array<{ side: -1 | 1; t: number; life: number; drift: number }> = []
  private nextPuff = 0

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors, dt: number): void {
    const g = this.g
    const F = a.F
    this.nextPuff -= dt
    if (this.target > 0 && this.nextPuff <= 0) {
      this.puffs.push({ side: Math.random() < 0.5 ? -1 : 1, t: 0, life: rand(1.2, 1.6), drift: rand(0.7, 1) })
      this.nextPuff = rand(0.22, 0.36)
    }
    for (const p of this.puffs) p.t += dt
    this.puffs = this.puffs.filter((p) => p.t < p.life)
    const eyeTop = Math.min(a.eyeL.y0, a.eyeR.y0)
    g.clear()
    for (const p of this.puffs) {
      const k = p.t / p.life
      const edge = p.side < 0 ? a.face.x0 : a.face.x1
      const base = at(a, { x: edge, y: eyeTop }, p.side * F * 0.06, -F * 0.18)
      const pos = at(a, base, p.side * F * 0.22 * k * p.drift, -F * 0.26 * k)
      const r = F * (0.045 + 0.075 * k)
      const alpha = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * 0.9
      g.lineStyle(F * 0.005, 0xc9c9d2, alpha)
      g.beginFill(0xffffff, alpha)
      g.drawCircle(pos.x, pos.y, r)
      g.drawCircle(pos.x + r * 0.75 * p.side, pos.y + r * 0.3, r * 0.72)
      g.drawCircle(pos.x - r * 0.35 * p.side, pos.y + r * 0.55, r * 0.55)
      g.endFill()
    }
  }
}

/** 省略号：三个点依次出现，循环 */
class Ellipsis extends Overlay {
  private readonly g = new PIXI.Graphics()

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors): void {
    const g = this.g
    const F = a.F
    const cycle = this.t % 1.8
    g.clear()
    for (let i = 0; i < 3; i++) {
      if (cycle < i * 0.35) continue
      const p = at(a, { x: a.face.x1, y: a.face.y0 }, F * (0.12 + i * 0.085), F * 0.08)
      g.lineStyle(F * 0.008, 0x26262b, 1)
      g.beginFill(0xffffff, 1)
      g.drawCircle(p.x, p.y, F * 0.024)
      g.endFill()
    }
  }
}

/** ZZZ：Z 字母从头侧向右上方飘起 */
class Zzz extends Overlay {
  private letters: Array<{ t: number; text: PIXI.Text }> = []
  private nextZ = 0

  draw(a: Anchors, dt: number): void {
    const F = a.F
    this.nextZ -= dt
    if (this.target > 0 && this.nextZ <= 0) {
      const text = new PIXI.Text('Z', textStyle(120, 0xc9dcff, 0x2a3557))
      text.anchor.set(0.5)
      this.root.addChild(text)
      this.letters.push({ t: 0, text })
      this.nextZ = 1.1
    }
    const life = 2.6
    for (const l of this.letters) {
      l.t += dt
      const k = l.t / life
      const p = at(a, { x: a.face.x1, y: a.face.y0 }, F * (0.06 + 0.22 * k), F * (0.22 - 0.32 * k))
      l.text.position.set(p.x, p.y)
      l.text.rotation = a.roll - 0.25
      l.text.scale.set((F * (0.1 + 0.1 * k)) / 120)
      l.text.alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85
    }
    for (const l of this.letters.filter((x) => x.t >= life)) l.text.destroy()
    this.letters = this.letters.filter((l) => l.t < life)
  }
}

/** 脸红斜线（///）：两颊各三道 */
class BlushLines extends Overlay {
  private readonly g = new PIXI.Graphics()

  constructor(parent: PIXI.Container) {
    super(parent)
    this.root.addChild(this.g)
  }

  draw(a: Anchors): void {
    const g = this.g
    const F = a.F
    g.clear()
    stroke(g, F * 0.009, 0xd23c4a, 0.8)
    for (const cheek of [a.cheekL, a.cheekR]) {
      for (let i = -1; i <= 1; i++) {
        const p0 = at(a, cheek, F * (i * 0.04 + 0.018), -F * 0.03)
        const p1 = at(a, cheek, F * (i * 0.04 - 0.018), F * 0.03)
        g.moveTo(p0.x, p0.y)
        g.lineTo(p1.x, p1.y)
      }
    }
  }
}

export class OverlayLayer {
  private readonly root = new PIXI.Container()
  private readonly overlays: Record<OverlayKind, Overlay>
  private readonly internal: InternalLike
  private readonly ids = new Map<string, number>()

  constructor(private readonly model: Live2DModel) {
    this.internal = model.internalModel as unknown as InternalLike
    model.addChild(this.root)
    this.overlays = {
      gloom: new Gloom(this.root),
      blushLines: new BlushLines(this.root),
      tears: new Tears(this.root),
      vein: new Vein(this.root),
      sweat: new Sweat(this.root),
      steam: new Steam(this.root),
      sparkle: new Sparkle(this.root),
      ellipsis: new Ellipsis(this.root),
      zzz: new Zzz(this.root),
      question: new Question(this.root),
      exclaim: new Exclaim(this.root)
    }
  }

  /** 切换到一组符号：列表里的淡入（一次性符号重新计时），其余淡出 */
  setActive(kinds: readonly OverlayKind[], retrigger = true): void {
    for (const [kind, overlay] of Object.entries(this.overlays) as Array<[OverlayKind, Overlay]>) {
      if (kinds.includes(kind)) {
        const duration = TRANSIENT[kind] ?? null
        if (retrigger || overlay.target === 0) overlay.show(duration)
      } else {
        overlay.hide()
      }
    }
  }

  /** 单独弹出一个符号（不影响其他） */
  flash(kind: OverlayKind): void {
    this.overlays[kind].show(TRANSIENT[kind] ?? 2.5)
  }

  update(dt: number): void {
    let anchors: Anchors | null = null
    for (const overlay of Object.values(this.overlays)) {
      if (!overlay.step(dt)) continue
      anchors ??= this.computeAnchors()
      if (anchors) overlay.draw(anchors, dt)
    }
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }

  // —— 锚点 ——

  private indexOf(id: string, core: CoreLike): number {
    let index = this.ids.get(id)
    if (index === undefined) {
      index = core.getDrawableIndex(id)
      this.ids.set(id, index)
    }
    return index
  }

  /** 若干网格的包围盒（模型局部坐标） */
  private bounds(ids: readonly string[]): Rect | null {
    const core = this.internal.coreModel as CoreLike
    const { pixelsPerUnit: ppu, originalWidth: ow, originalHeight: oh, localTransform: lt } = this.internal
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const id of ids) {
      const index = this.indexOf(id, core)
      if (index < 0) continue
      const v = core.getDrawableVertices(index)
      for (let i = 0; i < v.length; i += 2) {
        // 模型单位 → 模型像素（与 InternalModel.getDrawableVertices 同式）→ 局部坐标
        const px = v[i]! * ppu + ow / 2
        const py = -v[i + 1]! * ppu + oh / 2
        const lx = lt.a * px + lt.c * py + lt.tx
        const ly = lt.b * px + lt.d * py + lt.ty
        if (lx < x0) x0 = lx
        if (lx > x1) x1 = lx
        if (ly < y0) y0 = ly
        if (ly > y1) y1 = ly
      }
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 }
  }

  computeAnchors(): Anchors | null {
    const face = this.bounds([DRAWABLES.face])
    const eyeL = this.bounds(DRAWABLES.eyeL)
    const eyeR = this.bounds(DRAWABLES.eyeR)
    const cheekL = this.bounds([DRAWABLES.cheekBlush[0]])
    const cheekR = this.bounds([DRAWABLES.cheekBlush[1]])
    if (!face || !eyeL || !eyeR || !cheekL || !cheekR || face.x1 - face.x0 < 1) return null
    const l = center(eyeL)
    const r = center(eyeR)
    return {
      face,
      F: face.x1 - face.x0,
      eyeL,
      eyeR,
      cheekL: center(cheekL),
      cheekR: center(cheekR),
      roll: Math.atan2(r.y - l.y, r.x - l.x)
    }
  }

  /** 脖子位置（脸部下缘中点，模型局部坐标）：整体歪头的旋转中心 */
  neckPoint(): Pt | null {
    const face = this.bounds([DRAWABLES.face])
    // 首次渲染前网格顶点尚未计算（全为 0），此时不取，下一帧再试
    if (!face || face.x1 - face.x0 < 1) return null
    return { x: (face.x0 + face.x1) / 2, y: face.y1 }
  }

  /** 调试：锚点所在区域转成屏幕坐标（CSS 像素） */
  regionOnScreen(kind: 'face' | 'head'): { x: number; y: number; width: number; height: number } | null {
    const a = this.computeAnchors()
    if (!a) return null
    const F = a.F
    const r =
      kind === 'face'
        ? { x0: a.face.x0 - F * 0.12, y0: Math.min(a.eyeL.y0, a.eyeR.y0) - F * 0.32, x1: a.face.x1 + F * 0.12, y1: a.face.y1 + F * 0.08 }
        : { x0: a.face.x0 - F * 0.75, y0: a.face.y0 - F * 0.45, x1: a.face.x1 + F * 0.75, y1: a.face.y1 + F * 0.3 }
    // 以区域中心定位、按缩放换算尺寸：整体歪头时裁剪框大小不变，便于对比
    const c = this.model.toGlobal(new PIXI.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
    const scale = Math.hypot(this.model.worldTransform.a, this.model.worldTransform.b)
    const width = (r.x1 - r.x0) * scale
    const height = (r.y1 - r.y0) * scale
    return { x: c.x - width / 2, y: c.y - height / 2, width, height }
  }
}
