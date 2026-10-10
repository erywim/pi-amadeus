import { normalizeEmotion, normalizeGesture, type Emotion, type Gesture } from '@pi-amadeus/shared'

/**
 * 双语言流增量解析器——大脑 ↔ LLM 的内部契约：
 * LLM 在语音模式按行输出【日】…/【中】…句对（日文在前）与可选的【情】情绪行、【动】动作行，
 * 本解析器按完整行切分，产出中文增量（上屏）、日文句子（TTS）、情绪与动作（Live2D）。
 * 容错：未标记行按中文处理；全程无标记时全文归中文（跳过 TTS）；
 * 一行挤了多个标记时拆开处理；【情绪】/【表情】/【动作】等近似写法同样识别。
 */

const JP_PREFIX = '【日】'
const CN_PREFIX = '【中】'
const EMO_MARKER = /^【(?:情|情绪|表情)】/
const GESTURE_MARKER = /^【(?:动|动作)】/
/** 在每个已知标记前切开（零宽断言，标记保留在段首） */
const MARKER_SPLIT = /(?=【(?:日|中|情|情绪|表情|动|动作)】)/

export interface ParserOutput {
  /** 本次 feed 新增的中文（供 UI 上屏） */
  cnDelta: string
  /** 本次 feed 完成的日文句子（供 TTS，逐句） */
  jpSentences: string[]
  /** 本次 feed 的情绪变化 */
  emotion: Emotion | null
  /** 本次 feed 出现的动作（按出现顺序） */
  gestures: Gesture[]
}

interface LineResult {
  cn: string
  jp: string[]
  emotion: Emotion | null
  gestures: Gesture[]
}

const EMPTY: ParserOutput = { cnDelta: '', jpSentences: [], emotion: null, gestures: [] }

export class BilingualParser {
  private buffer = ''
  private cnFull = ''
  private jpFull = ''
  private currentEmotion: Emotion = 'neutral'
  private sawMarker = false

  /** 消费一个流式增量；只处理完整行，半行留在 buffer 等下一段 */
  feed(delta: string): ParserOutput {
    this.buffer += delta
    const out: ParserOutput = { cnDelta: '', jpSentences: [], emotion: null, gestures: [] }
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      this.merge(out, this.handleLine(line))
    }
    return out.cnDelta || out.jpSentences.length || out.emotion || out.gestures.length ? out : EMPTY
  }

  /** 流结束时冲刷：残留半行按同规则处理；无标记全程归中文 */
  finish(): ParserOutput {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (!rest) return EMPTY
    if (!this.sawMarker) {
      this.cnFull += rest
      return { cnDelta: rest, jpSentences: [], emotion: null, gestures: [] }
    }
    const out: ParserOutput = { cnDelta: '', jpSentences: [], emotion: null, gestures: [] }
    this.merge(out, this.handleLine(rest))
    return out
  }

  private merge(out: ParserOutput, r: LineResult): void {
    if (r.cn) out.cnDelta += r.cn
    out.jpSentences.push(...r.jp)
    if (r.emotion) out.emotion = r.emotion
    out.gestures.push(...r.gestures)
  }

  private handleLine(line: string): LineResult {
    const parts = line.split(MARKER_SPLIT).map((part) => part.trim()).filter(Boolean)
    if (parts.length > 1) {
      const merged: LineResult = { cn: '', jp: [], emotion: null, gestures: [] }
      for (const part of parts) {
        const r = this.handleSegment(part)
        merged.cn += r.cn
        merged.jp.push(...r.jp)
        if (r.emotion) merged.emotion = r.emotion
        merged.gestures.push(...r.gestures)
      }
      return merged
    }
    return this.handleSegment(line)
  }

  private handleSegment(line: string): LineResult {
    const result: LineResult = { cn: '', jp: [], emotion: null, gestures: [] }
    if (line.startsWith(JP_PREFIX)) {
      this.sawMarker = true
      const text = line.slice(JP_PREFIX.length).trim()
      if (text) {
        this.jpFull += text
        result.jp.push(text)
      }
      return result
    }
    if (line.startsWith(CN_PREFIX)) {
      this.sawMarker = true
      const text = line.slice(CN_PREFIX.length).trim()
      if (text) {
        this.cnFull += text
        result.cn = text
      }
      return result
    }
    const emo = EMO_MARKER.exec(line)
    if (emo) {
      // 只取第一个词：容忍"happy（开心）"这类附带说明
      const name = line.slice(emo[0].length).trim().split(/[\s,，、（(]/)[0]
      const emotion = normalizeEmotion(name)
      if (emotion) {
        this.currentEmotion = emotion
        result.emotion = emotion
      }
      return result
    }
    const ges = GESTURE_MARKER.exec(line)
    if (ges) {
      // 允许一行多个动作："nod tilt" / "nod、tilt"
      for (const name of line.slice(ges[0].length).split(/[\s,，、/]+/)) {
        const gesture = normalizeGesture(name)
        if (gesture) result.gestures.push(gesture)
      }
      return result
    }
    // 未标记行：容错按中文展示
    this.sawMarker = true
    this.cnFull += line
    result.cn = line
    return result
  }

  /** 规范中文全文（落库 content） */
  get cn(): string {
    return this.cnFull
  }

  /** 日文全文（落库 tts_text，不进 LLM 上下文） */
  get jp(): string {
    return this.jpFull
  }

  get emotion(): Emotion {
    return this.currentEmotion
  }
}

/** 简单的异步队列：支持非阻塞 tryShift 与异步迭代 drain */
export class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  tryShift(): T | undefined {
    return this.items.shift()
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve({ value: item, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() }
  }
}
