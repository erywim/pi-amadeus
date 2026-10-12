import { normalizeEmotion, normalizeGesture, type Emotion, type Gesture } from '@pi-amadeus/shared'

/**
 * 双语言流增量解析器——大脑 ↔ LLM 的内部契约：
 * LLM 在语音模式按行输出【日】…/【中】…句对（日文在前）与可选的【情】情绪行、【动】动作行，
 * 本解析器按完整行切分，产出中文增量（上屏）、日文句子（TTS）、情绪与动作（Live2D）。
 * 容错：未标记行按中文处理；全程无标记时全文归中文（跳过 TTS）；
 * 一行挤了多个标记时拆开处理；【情绪】/【表情】/【动作】等近似写法同样识别；
 * 情绪/动作名容忍尾随中英文标点与括号说明；
 * 无法识别的名字按协议噪音丢弃，但名字前后的正文（标记被写进行中）并回中文，内容不丢。
 * 顺序：同一批增量内多个行的事件按出现顺序产出（见 ParserOutput.events），
 * 动作不会先于它从属的文本发出；同一批里多个情绪行时后者覆盖前者（都会发事件）。
 */

const JP_PREFIX = '【日】'
const CN_PREFIX = '【中】'
const EMO_MARKER = /^【(?:情|情绪|表情)】/
const GESTURE_MARKER = /^【(?:动|动作)】/
/** 在每个已知标记前切开（零宽断言，标记保留在段首） */
const MARKER_SPLIT = /(?=【(?:日|中|情|情绪|表情|动|动作)】)/
/** 情绪/动作词的分隔符：空白、常见中英文标点、括号、斜杠 */
const NAME_BREAK = /[\s,，、。！？!?；;：:/（(）)]/
/** 括号说明（happy（开心））整体剥掉后再解析 */
const ANNOTATION = /（[^（）]*）|\([^()]*\)/g
/** 含 CJK（≈正文内容，而非输错的协议名） */
const HAS_CJK = /[぀-ヿ㐀-鿿]/

/** 有序事件：情绪/动作/中文增量按行内出现顺序排列（日文走独立的 jpSentences 通道） */
export type ParserEvent =
  | { type: 'emotion'; emotion: Emotion }
  | { type: 'gesture'; gesture: Gesture }
  | { type: 'cn'; text: string }

export interface ParserOutput {
  /** 本次 feed 新增的中文（供 UI 上屏） */
  cnDelta: string
  /** 本次 feed 完成的日文句子（供 TTS，逐句） */
  jpSentences: string[]
  /** 本次 feed 的情绪变化（同一批里多个时保留最后一个） */
  emotion: Emotion | null
  /** 本次 feed 出现的动作（按出现顺序） */
  gestures: Gesture[]
  /** 情绪/动作/中文增量的有序序列（voice 回合按它依序发 SSE） */
  events: ParserEvent[]
}

interface LineResult {
  cn: string
  jp: string[]
  emotion: Emotion | null
  gestures: Gesture[]
  events: ParserEvent[]
}

/** 共享的空结果：深冻结防误改（外层断言是因为 readonly 数组不满足可变签名——
 *  调用方只读，一律不得对返回对象做原地修改） */
const EMPTY = Object.freeze({
  cnDelta: '',
  jpSentences: Object.freeze([]),
  emotion: null,
  gestures: Object.freeze([]),
  events: Object.freeze([])
}) as unknown as ParserOutput

export class BilingualParser {
  private buffer = ''
  private cnFull = ''
  private jpFull = ''
  private currentEmotion: Emotion = 'neutral'
  private sawMarker = false

  /** 消费一个流式增量；只处理完整行，半行留在 buffer 等下一段 */
  feed(delta: string): ParserOutput {
    this.buffer += delta
    const out = this.blankOutput()
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
      return { cnDelta: rest, jpSentences: [], emotion: null, gestures: [], events: [{ type: 'cn', text: rest }] }
    }
    const out = this.blankOutput()
    this.merge(out, this.handleLine(rest))
    return out
  }

  private blankOutput(): ParserOutput {
    return { cnDelta: '', jpSentences: [], emotion: null, gestures: [], events: [] }
  }

  private merge(out: ParserOutput, r: LineResult): void {
    out.cnDelta += r.cn
    out.jpSentences.push(...r.jp)
    if (r.emotion) out.emotion = r.emotion
    out.gestures.push(...r.gestures)
    out.events.push(...r.events)
  }

  private handleLine(line: string): LineResult {
    const parts = line.split(MARKER_SPLIT).map((part) => part.trim()).filter(Boolean)
    if (parts.length > 1) {
      // 标记写进行中：逐段处理，解析不了的名字不吞正文（见 handleSegment 的兜底）
      const merged: LineResult = { cn: '', jp: [], emotion: null, gestures: [], events: [] }
      for (const part of parts) {
        const r = this.handleSegment(part, true)
        merged.cn += r.cn
        merged.jp.push(...r.jp)
        if (r.emotion) merged.emotion = r.emotion
        merged.gestures.push(...r.gestures)
        merged.events.push(...r.events)
      }
      return merged
    }
    return this.handleSegment(line, false)
  }

  private handleSegment(line: string, midLine: boolean): LineResult {
    const result: LineResult = { cn: '', jp: [], emotion: null, gestures: [], events: [] }
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
        result.events.push({ type: 'cn', text })
      }
      return result
    }
    const emo = EMO_MARKER.exec(line)
    if (emo) {
      // 名字与后文/标点的分隔（含全角标点与"happy（开心）"式括号说明）
      const rest = line.slice(emo[0].length).replace(ANNOTATION, '')
      const name = rest.trim().split(NAME_BREAK)[0] ?? ''
      const emotion = normalizeEmotion(name)
      if (emotion) {
        this.currentEmotion = emotion
        result.emotion = emotion
        result.events.push({ type: 'emotion', emotion })
        // 名字之后的正文（如「好的【情】happy 我很开心」的后半句）：含 CJK 才并回中文，
        // 纯标点/说明丢弃，正文绝不静默消失
        const nameAt = rest.indexOf(name)
        const tail = nameAt >= 0 ? rest.slice(nameAt + name.length).trim() : ''
        if (HAS_CJK.test(tail)) {
          this.sawMarker = true
          this.cnFull += tail
          result.cn = tail
          result.events.push({ type: 'cn', text: tail })
        }
        return result
      }
      const text = rest.trim()
      if (text && (midLine || HAS_CJK.test(text))) {
        // 名字无法识别：行中段的内容整段并回中文；含 CJK 的明显是正文
        // （独立标记行里纯 ASCII 的未知名多属输错的协议名，静默丢弃）
        this.sawMarker = true
        this.cnFull += text
        result.cn = text
        result.events.push({ type: 'cn', text })
      }
      return result
    }
    const ges = GESTURE_MARKER.exec(line)
    if (ges) {
      const rest = line.slice(ges[0].length).replace(ANNOTATION, '')
      // 逐个取词（先吃掉分隔符再取词），命中动作就收；
      // 从第一个无法识别的词起整段并回中文——动作列表必须从头连续合法
      const wordRe = /[\s,，、。！？!?；;：:/（(）)]*([^\s,，、。！？!?；;：:/（(）)]+)/y
      let pos = 0
      let cn = ''
      while (pos < rest.length) {
        wordRe.lastIndex = pos
        const m = wordRe.exec(rest)
        if (!m) break
        const token = m[1]!
        const tokenAt = m.index + m[0].length - token.length
        pos = wordRe.lastIndex
        const gesture = normalizeGesture(token)
        if (gesture) {
          result.gestures.push(gesture)
          result.events.push({ type: 'gesture', gesture })
        } else if (midLine || HAS_CJK.test(token)) {
          cn = rest.slice(tokenAt).trim()
          break
        }
        // 纯 ASCII 未知词（输错的协议名）静默丢弃，继续扫后面的词
      }
      if (cn) {
        this.sawMarker = true
        this.cnFull += cn
        result.cn = cn
        result.events.push({ type: 'cn', text: cn })
      }
      return result
    }
    // 未标记行：容错按中文展示
    this.sawMarker = true
    this.cnFull += line
    result.cn = line
    result.events.push({ type: 'cn', text: line })
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
