/**
 * 上下文 token 估算（无分词器依赖）：只用于"是否该压缩"的阈值判断，
 * 不用于计费。宁可高估——低估会让压缩晚触发，最终撞上供应商的硬上限。
 *
 * 经验比例（参考 Claude Code 的 tokenEstimation 思路，按中日文场景调整）：
 * - CJK / 全角字符：约 1 token / 字
 * - 其余（英文、数字、代码、标点）：约 3.5 字符 / token
 * - 每条消息另有固定开销（role / 分隔符）
 */

/** CJK 统一表意文字、假名、全角标点、CJK 符号与标点 */
const CJK_PATTERN =
  /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿︰-﹏＀-￯]/u

/** 每条消息的固定开销（role、分隔符、时间戳等） */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** 单段文本的 token 估算 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 3.5)
}

/** 一组消息（只取文本部分）的 token 估算 */
export function estimateMessagesTokens(messages: { content: string }[]): number {
  let total = 0
  for (const message of messages) total += estimateTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS
  return total
}
