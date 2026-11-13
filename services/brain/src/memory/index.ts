import type { Db } from '../db.ts'
import type { LlmTarget } from '../llm.ts'
import { recordAffinityTurn, recordMemoryAffinity } from './affinity.ts'
import { extractMemories } from './extract.ts'

export { recallMemories, memorySystemPrompt, keywordsOf } from './recall.ts'
export { summarizeAffinity, recordAffinityTurn, recordMemoryAffinity, affinityDeltaOf } from './affinity.ts'
export { extractMemories } from './extract.ts'

/**
 * 回合结束后的记忆/好感副作用（不阻塞 done）：
 * 先记好感事件，再尝试提取记忆；提取成功额外记一笔「被记住」。
 * 任何一步失败都不会影响已经完成的回合。
 */
export async function onTurnFinished(input: {
  db: Db
  target: LlmTarget
  userId: string
  sessionId: string
  messageId: string
  userText: string
  assistantText: string
  toolCalls: number
}): Promise<void> {
  await recordAffinityTurn(input.db, input.userId, {
    userText: input.userText,
    assistantText: input.assistantText,
    toolCalls: input.toolCalls
  })
  const added = await extractMemories({
    db: input.db,
    target: input.target,
    userId: input.userId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    userText: input.userText,
    assistantText: input.assistantText
  })
  if (added > 0) await recordMemoryAffinity(input.db, input.userId)
}
