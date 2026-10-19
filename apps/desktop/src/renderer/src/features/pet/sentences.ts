// 句末：中文句号与问叹号（含连用及随后的右引号/括号）、英文问叹号、换行。
// 省略号不算（"……什么事？"是一句），英文句点不算（会误切小数）
const SENTENCE_END = /[。！？!?]+["”』」）)]*|\n+/g

/**
 * 把流式回复切成句子（XnneHangLab 的 PetBubble 按句显示：新句淡入、上一句缩成一行）。
 * 最后一段可能还没说完，照样作为当前句。
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let last = 0
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length
    const piece = text.slice(last, end).trim()
    if (piece) out.push(piece)
    last = end
  }
  const tail = text.slice(last).trim()
  if (tail) out.push(tail)
  return out
}
