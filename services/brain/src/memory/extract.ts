import type { MemoryKind } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'
import { completeText, type LlmTarget } from '../llm.ts'

/**
 * 记忆提取：每轮成功后用用户自己的模型做一次小请求，从「这轮对话」里
 * 提取值得长期记住的事实。只在模型真的给出条目时落库，不预置、不猜测。
 * 失败只告警——记忆是增强能力，不能影响回合本身。
 */

const EXTRACT_SYSTEM = `你是「Amadeus」的长期记忆整理器。读下面这一轮对话，提取值得长期记住的信息。

只提取用户主动提供的、对未来对话有用的稳定事实：
- fact：身份、职业、所在地、长期目标、掌握的知识
- preference：喜好、厌恶、习惯、沟通偏好
- event：发生过的、以后还会被提起的重要事件
- relationship：与用户有关的人、宠物、关系变化

不要提取：寒暄、一次性的情绪、助手自己说的话、常识、猜测。
输出格式：每行一条，kind|内容。kind 只能是 fact/preference/event/relationship，最多 3 条。
内容用中文，一句话，不超过 60 字，不要编造。
没有值得记住的内容就只输出 NONE。`

const KINDS = new Set<MemoryKind>(['fact', 'preference', 'event', 'relationship'])

export interface ExtractInput {
  db: Db
  target: LlmTarget
  userId: string
  sessionId: string
  messageId: string
  userText: string
  assistantText: string
}

/** 返回本轮新增的记忆条数（0 表示模型认为没有值得记的） */
export async function extractMemories(input: ExtractInput): Promise<number> {
  const userText = input.userText.trim()
  const assistantText = input.assistantText.trim()
  // 太短的寒暄不值得花一次模型调用，也几乎不可能有可记内容
  if (userText.length < 4 || assistantText.length === 0) return 0

  const raw = await completeText(
    input.target,
    {
      systemPrompt: EXTRACT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `用户：${userText.slice(0, 2000)}\n助手：${assistantText.slice(0, 2000)}`,
          timestamp: Date.now()
        }
      ]
    },
    { temperature: 0.2, maxTokens: 240, thinkingLevel: 'off' }
  )

  const candidates = parseCandidates(raw)
  if (candidates.length === 0) return 0

  const existing = await input.db.listMemories(input.userId)
  const known = existing.map((memory) => normalize(memory.content))
  let added = 0
  for (const candidate of candidates) {
    const normalized = normalize(candidate.content)
    if (!normalized || normalized === normalize('NONE')) continue
    // 完全相同或互相包含都视为已有：记忆库要的是稳定事实，不是同义复读
    if (known.some((item) => item === normalized || item.includes(normalized) || normalized.includes(item))) {
      continue
    }
    await input.db.addMemory({
      userId: input.userId,
      content: candidate.content,
      kind: candidate.kind,
      sourceSessionId: input.sessionId,
      sourceMessageId: input.messageId
    })
    known.push(normalized)
    added += 1
  }
  return added
}

function parseCandidates(raw: string): { kind: MemoryKind; content: string }[] {
  const text = raw.trim()
  if (!text || /^NONE$/i.test(text)) return []
  const result: { kind: MemoryKind; content: string }[] = []
  for (const line of text.split('\n')) {
    const cleaned = line.replace(/^[-*\d.\s]+/, '').trim()
    if (!cleaned || /^NONE$/i.test(cleaned)) continue
    const separator = cleaned.indexOf('|')
    const kindRaw = separator > 0 ? cleaned.slice(0, separator).trim().toLowerCase() : 'fact'
    const content = (separator > 0 ? cleaned.slice(separator + 1) : cleaned).trim()
    if (!content || content.length < 3) continue
    result.push({
      kind: KINDS.has(kindRaw as MemoryKind) ? (kindRaw as MemoryKind) : 'fact',
      content: content.slice(0, 200)
    })
    if (result.length >= 3) break
  }
  return result
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，。！？、：；,.!?;:'"“”‘’()（）]/g, '')
    .trim()
}
