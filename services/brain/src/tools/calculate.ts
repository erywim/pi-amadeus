import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** 计算器：递归下降求值器（无 mathjs 依赖），Math 函数白名单 + 除零/溢出守卫 */

export const calculateToolSchema = Type.Object({
  expression: Type.String({
    description: '数学表达式：数字、+ - * / % ^、括号，以及 sqrt/sin/cos/tan/log/abs/round/floor/ceil'
  })
})

type CalculateArgs = Static<typeof calculateToolSchema>

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: (x) => Math.sqrt(x),
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil
}

/** 求值器：expr = term (('+'|'-') term)*，右结合幂、一元负号、函数调用 */
function evaluate(expression: string): number {
  const src = expression.trim()
  if (!src) throw new Error('表达式为空')
  if (src.length > 200) throw new Error('表达式过长（上限 200 字符）')
  if (!/^[0-9+\-*/%^().,a-zA-Z_ ]+$/.test(src)) {
    throw new Error('表达式含非法字符（仅支持数字、运算符、括号与基础函数）')
  }
  const tokens = src.match(/\d+(?:\.\d+)?|[a-zA-Z_]+|[+\-*/%^()]|./g) ?? []

  let pos = 0
  const peek = (): string | undefined => tokens[pos]
  const next = (): string => {
    const t = tokens[pos]
    pos += 1
    return t ?? ''
  }
  const expect = (t: string): void => {
    if (next() !== t) throw new Error(`缺少 ${t}`)
  }
  const check = (value: number): number => {
    if (!Number.isFinite(value)) throw new Error('计算结果溢出或超出定义域')
    return value
  }

  function parseExpr(): number {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const rhs = parseTerm()
      value = op === '+' ? value + rhs : value - rhs
    }
    return value
  }

  function parseTerm(): number {
    let value = parseFactor()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next()
      const rhs = parseFactor()
      if ((op === '/' || op === '%') && rhs === 0) throw new Error('除数不能为零')
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs
    }
    return value
  }

  function parseFactor(): number {
    let value = parseUnary()
    if (peek() === '^') {
      next()
      value = Math.pow(value, parseFactor()) // 右结合
    }
    return check(value)
  }

  function parseUnary(): number {
    if (peek() === '-') {
      next()
      return -parseUnary()
    }
    return parsePrimary()
  }

  function parsePrimary(): number {
    const t = peek()
    if (t === undefined) throw new Error('表达式不完整')
    if (t === '(') {
      next()
      const value = parseExpr()
      expect(')')
      return value
    }
    if (/^[a-zA-Z_]/.test(t)) {
      const name = next()
      if (!(name in FUNCTIONS)) throw new Error(`未知函数：${name}`)
      expect('(')
      const arg = parseExpr()
      expect(')')
      return check(FUNCTIONS[name]?.(arg) ?? NaN)
    }
    const num = Number(next())
    if (!Number.isFinite(num)) throw new Error(`无法解析：${t}`)
    return num
  }

  const result = parseExpr()
  if (peek() !== undefined) throw new Error(`多余内容：${tokens.slice(pos).join('')}`)
  return check(result)
}

export function createCalculateTool(): AgentTool<typeof calculateToolSchema> {
  return {
    name: 'calculate',
    label: '计算器',
    description: '计算数学表达式。适合确定性计算（加减乘除、幂、百分比、三角函数等），LLM 心算不可靠时使用。',
    parameters: calculateToolSchema,
    execute: async (_toolCallId, params: CalculateArgs) => {
      const value = evaluate(params.expression)
      // toPrecision(12) 消浮点误差（0.1+0.2 → 0.3），再除掉尾随零
      const formatted = Number(value.toPrecision(12))
      return {
        content: [{ type: 'text', text: `结果：${formatted}` }],
        details: { expression: params.expression, value: formatted }
      }
    }
  }
}
