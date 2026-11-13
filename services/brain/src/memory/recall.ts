import type { AffinitySummary, MemoryItem } from '@pi-amadeus/shared'
import type { Db, MemoryRow } from '../db.ts'

/**
 * 记忆召回：不引入 embedding 依赖，用「关键词命中 + 置顶 + 新近度」排序。
 * 中文按 2-gram 切分（无分词词典也能覆盖大部分口语查询），英文按词。
 * 局限：同义改写召回不到；这是 v1 的已知取舍，不是数据造假。
 */

const STOPWORDS = new Set([
  '什么',
  '怎么',
  '可以',
  '这个',
  '那个',
  '我们',
  '你们',
  '他们',
  '一下',
  '现在',
  '还是',
  '就是',
  '因为',
  '所以',
  '如果',
  '但是',
  'the',
  'and',
  'for',
  'you',
  'that',
  'this',
  'with',
  'what',
  'how'
])

export function keywordsOf(text: string): string[] {
  const keywords = new Set<string>()
  // 只保留字母/数字（含中文），其余标点统一当分隔符：避免手写标点表漏字符
  const segments = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  for (const segment of segments) {
    const chinese = /[一-鿿]/.test(segment)
    if (chinese) {
      const chars = [...segment].filter((char) => /[一-鿿]/.test(char))
      for (let index = 0; index + 1 < chars.length; index += 1) {
        const gram = chars[index]! + chars[index + 1]!
        if (!STOPWORDS.has(gram)) keywords.add(gram)
      }
    } else if (segment.length >= 2 && !STOPWORDS.has(segment)) {
      keywords.add(segment)
    }
    if (keywords.size >= 24) break
  }
  return [...keywords]
}

/** 置顶记忆永远带上；其余按命中关键词数排序，同分取更新的 */
export async function recallMemories(
  db: Db,
  userId: string,
  query: string,
  limit = 8
): Promise<MemoryRow[]> {
  const all = await db.listMemories(userId)
  if (all.length === 0) return []
  const pinned = all.filter((memory) => memory.pinned).slice(0, 4)
  const keywords = keywordsOf(query)
  const scored = all
    .filter((memory) => !memory.pinned)
    .map((memory) => {
      let score = 0
      for (const keyword of keywords) {
        if (memory.content.toLowerCase().includes(keyword)) score += 1
      }
      return { memory, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
    .slice(0, Math.max(0, limit - pinned.length))
    .map((item) => item.memory)
  const picked = [...pinned, ...scored]
  if (picked.length > 0) await db.touchMemories(picked.map((memory) => memory.id))
  return picked
}

const STAGE_LABELS: Record<string, string> = {
  stranger: '陌生',
  acquaintance: '认识',
  familiar: '熟悉',
  close: '亲近',
  fond: '喜欢',
  beloved: '挚爱'
}

/** 注入 system prompt 的记忆与关系段落（没有记忆/互动时返回空串） */
export function memorySystemPrompt(memories: MemoryItem[] | MemoryRow[], affinity: AffinitySummary | null): string {
  const sections: string[] = []
  if (memories.length > 0) {
    sections.push(
      [
        '## 长期记忆',
        '以下是你和用户过去真实发生过的事（按相关度挑选）。自然地使用这些信息，',
        '不要逐条复述，也不要说“根据我的记忆”。',
        ...memories.map((memory) => `- ${memory.content}`)
      ].join('\n')
    )
  }
  if (affinity && affinity.events.length > 0) {
    sections.push(
      [
        '## 关系状态',
        `当前好感度 ${affinity.score}，阶段：${STAGE_LABELS[affinity.stageKey] ?? affinity.stageKey}。`,
        '语气亲密度与这个阶段相符，但不要主动报数值，也不要把关系当成任务。'
      ].join('\n')
    )
  }
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
}
