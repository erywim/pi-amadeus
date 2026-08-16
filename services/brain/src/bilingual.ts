import { isEmotion, type Emotion } from '@pi-amadeus/shared'

/**
 * 双语言流增量解析器——大脑 ↔ LLM 的内部契约：
 * LLM 在语音模式按行输出【日】…/【中】…句对（日文在前）与可选【情】情绪行，
 * 本解析器按完整行切分，产出中文增量（上屏）与日文句子（TTS）。
 * 容错：未标记行按中文处理；全程无标记时全文归中文（跳过 TTS）。
 */

const JP_PREFIX = '【日】'
const CN_PREFIX = '【中】'
const EMO_PREFIX = '【情】'

export interface ParserOutput {
  /** 本次 feed 新增的中文（供 UI 上屏） */
  cnDelta: string
  /** 本次 feed 完成的日文句子（供 TTS，逐句） */
  jpSentences: string[]
  /** 本次 feed 的情绪变化 */
  emotion: Emotion | null
}

const EMPTY: ParserOutput = { cnDelta: '', jpSentences: [], emotion: null }

export class BilingualParser {
  private buffer = ''
  private cnFull = ''
  private jpFull = ''
  private currentEmotion: Emotion = 'neutral'
  private sawMarker = false

  /** 消费一个流式增量；只处理完整行，半行留在 buffer 等下一段 */
  feed(delta: string): ParserOutput {
    this.buffer += delta
    const out: ParserOutput = { cnDelta: '', jpSentences: [], emotion: null }
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      const r = this.handleLine(line)
      if (r.cn) out.cnDelta += r.cn
      if (r.jp) out.jpSentences.push(r.jp)
      if (r.emotion) out.emotion = r.emotion
    }
    return out.cnDelta || out.jpSentences.length || out.emotion ? out : EMPTY
  }

  /** 流结束时冲刷：残留半行按同规则处理；无标记全程归中文 */
  finish(): ParserOutput {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (!rest) return EMPTY
    if (!this.sawMarker) {
      this.cnFull += rest
      return { cnDelta: rest, jpSentences: [], emotion: null }
    }
    const r = this.handleLine(rest)
    return { cnDelta: r.cn, jpSentences: r.jp ? [r.jp] : [], emotion: r.emotion }
  }

  private handleLine(line: string): { cn: string; jp: string | null; emotion: Emotion | null } {
    if (line.startsWith(JP_PREFIX)) {
      this.sawMarker = true
      const text = line.slice(JP_PREFIX.length).trim()
      if (text) {
        this.jpFull += text
        return { cn: '', jp: text, emotion: null }
      }
      return { cn: '', jp: null, emotion: null }
    }
    if (line.startsWith(CN_PREFIX)) {
      this.sawMarker = true
      const text = line.slice(CN_PREFIX.length).trim()
      if (text) {
        this.cnFull += text
        return { cn: text, jp: null, emotion: null }
      }
      return { cn: '', jp: null, emotion: null }
    }
    if (line.startsWith(EMO_PREFIX)) {
      const name = line.slice(EMO_PREFIX.length).trim()
      if (isEmotion(name)) {
        this.currentEmotion = name
        return { cn: '', jp: null, emotion: name }
      }
      return { cn: '', jp: null, emotion: null }
    }
    // 未标记行：容错按中文展示
    this.sawMarker = true
    this.cnFull += line
    return { cn: line, jp: null, emotion: null }
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
