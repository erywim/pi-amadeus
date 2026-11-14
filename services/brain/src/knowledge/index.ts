import { randomUUID } from 'node:crypto'
import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { KnowledgeSearchHit } from '@pi-amadeus/shared'
import type { Db } from '../db.ts'
import { keywordsOf } from '../memory/recall.ts'

/**
 * 知识库导入与检索。
 * 检索不引入 embedding 依赖：中文按 2-gram、英文按词切分，用 TF-IDF 打分。
 * 返回的是真实导入的原文片段，不做改写或摘要；没有命中就明确返回「未找到」。
 */

/** 单块上限（字符）。中文语义密度高，900 字足够一个完整段落组 */
export const CHUNK_MAX = 900
/** 长段硬切时的重叠长度，避免答案正好落在切口上 */
export const CHUNK_OVERLAP = 120
/** 单次导入上限（字符）：防止不小心把整个数据集塞进 SQLite */
export const DOC_MAX_CHARS = 400_000

/** 把文档切成块：优先按空行分段，段落过长再按窗口重叠切 */
export function chunkText(raw: string): string[] {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return []
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''

  const flush = (): void => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_MAX) {
      flush()
      let start = 0
      while (start < paragraph.length) {
        const end = Math.min(paragraph.length, start + CHUNK_MAX)
        chunks.push(paragraph.slice(start, end).trim())
        if (end >= paragraph.length) break
        start = Math.max(start + 1, end - CHUNK_OVERLAP)
      }
      continue
    }
    const merged = current ? `${current}\n\n${paragraph}` : paragraph
    if (merged.length > CHUNK_MAX) {
      flush()
      current = paragraph
    } else {
      current = merged
    }
  }
  flush()
  return chunks.filter((chunk) => chunk.length > 0)
}

/** 导入文档：切块 + 落库。返回文档行（含块数） */
export async function importKnowledgeDoc(
  db: Db,
  input: { kbId: string; name: string; content: string; source?: string }
): Promise<{ id: string; name: string; chunks: number; chars: number; source: string; createdAt: number }> {
  const content = input.content.replace(/\r\n/g, '\n').trim()
  if (!content) throw new Error('文档内容为空')
  if (content.length > DOC_MAX_CHARS) {
    throw new Error(`文档过大（${content.length} 字），单篇上限 ${DOC_MAX_CHARS} 字`)
  }
  const pieces = chunkText(content)
  if (pieces.length === 0) throw new Error('文档没有可导入的文本')
  const doc = await db.addKnowledgeDoc({
    id: randomUUID(),
    kbId: input.kbId,
    name: input.name.trim() || '未命名文档',
    source: (input.source ?? '').trim(),
    chunks: pieces.map((text) => ({ id: randomUUID(), content: text }))
  })
  return {
    id: doc.id,
    name: doc.name,
    chunks: doc.chunks,
    chars: doc.chars,
    source: doc.source,
    createdAt: doc.createdAt
  }
}

/** 词频（子串出现次数，最多计 5 次，避免长文堆词压过精确命中） */
function termFrequency(haystack: string, term: string): number {
  let count = 0
  let index = haystack.indexOf(term)
  while (index >= 0 && count < 5) {
    count += 1
    index = haystack.indexOf(term, index + term.length)
  }
  return count
}

/**
 * 检索：返回相关度最高的块。
 * 同一个知识库里按 TF-IDF 排序；多个知识库一起检索时共享 IDF，分数可比。
 */
export async function searchKnowledge(
  db: Db,
  userId: string,
  query: string,
  opts?: { kb?: string; limit?: number }
): Promise<KnowledgeSearchHit[]> {
  const terms = keywordsOf(query)
  if (terms.length === 0) return []
  const filter = (opts?.kb ?? '').trim().toLowerCase()
  const bases = (await db.listKnowledgeBases(userId)).filter(
    (base) =>
      !filter || base.id === filter || base.name.toLowerCase().includes(filter)
  )
  if (bases.length === 0) return []
  const kbNameOf = new Map(bases.map((base) => [base.id, base.name]))
  const chunks = await db.listKnowledgeChunks(
    bases.map((base) => base.id),
    8000
  )
  if (chunks.length === 0) return []

  const tokenized = chunks.map((chunk) => {
    const lower = chunk.content.toLowerCase()
    return { chunk, lower, counts: terms.map((term) => termFrequency(lower, term)) }
  })
  const docFreq = new Map<string, number>()
  for (const item of tokenized) {
    item.counts.forEach((count, index) => {
      if (count > 0) {
        const term = terms[index]!
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
      }
    })
  }
  const total = tokenized.length
  const scored = tokenized
    .map((item) => {
      let score = 0
      item.counts.forEach((count, index) => {
        if (count === 0) return
        const term = terms[index]!
        const df = docFreq.get(term) ?? 1
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
        score += (1 + Math.log(count)) * idf
      })
      // 长度归一：长块天然有更多词，不归一会让长文永远排前面
      return { chunk: item.chunk, score: score / Math.sqrt(Math.max(40, item.chunk.content.length)) }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(10, opts?.limit ?? 4)))

  return scored.map(({ chunk, score }) => ({
    chunkId: chunk.id,
    docId: chunk.docId,
    docName: chunk.docName,
    kbId: chunk.kbId,
    kbName: kbNameOf.get(chunk.kbId) ?? '',
    content: chunk.content,
    score: Math.round(score * 1000) / 1000
  }))
}

export const knowledgeToolSchema = Type.Object({
  query: Type.String({ description: '要在知识库里查找的问题或关键词' }),
  kb: Type.Optional(Type.String({ description: '限定知识库名称（可省略，默认搜索全部）' }))
})

type KnowledgeArgs = Static<typeof knowledgeToolSchema>

/**
 * search_knowledge 工具：只有用户建过知识库时才注册。
 * 工具描述里列出知识库名称，模型才知道该不该查。
 */
export async function createKnowledgeTool(
  db: Db,
  userId: string
): Promise<AgentTool<typeof knowledgeToolSchema> | null> {
  const bases = await db.listKnowledgeBases(userId)
  if (bases.length === 0) return null
  const names = bases.map((base) => `「${base.name}」`).join('、')
  return {
    name: 'search_knowledge',
    label: '检索知识库',
    description:
      `在用户导入的知识库（${names}）里检索原文片段。` +
      '当用户的问题可能涉及他导入的资料、文档、笔记时使用；回答里引用检索到的原文，不要编造没有出现过的内容。',
    parameters: knowledgeToolSchema,
    execute: async (_toolCallId, params: KnowledgeArgs) => {
      const hits = await searchKnowledge(db, userId, params.query, {
        ...(params.kb ? { kb: params.kb } : {}),
        limit: 4
      })
      if (hits.length === 0) {
        return {
          content: [{ type: 'text', text: `知识库里没有找到与「${params.query}」相关的内容。` }],
          details: { query: params.query, count: 0 }
        }
      }
      const text = hits
        .map(
          (hit, index) =>
            `[${index + 1}] 知识库「${hit.kbName}」/ 文档《${hit.docName}》\n${hit.content}`
        )
        .join('\n\n---\n\n')
      return {
        content: [{ type: 'text', text }],
        details: {
          query: params.query,
          count: hits.length,
          hits: hits.map((hit) => ({
            kbId: hit.kbId,
            docId: hit.docId,
            docName: hit.docName,
            score: hit.score
          }))
        }
      }
    }
  }
}

/** 系统提示里的知识库段落：让模型知道「有资料可查」，没有知识库时返回空串 */
export async function knowledgeSystemPrompt(db: Db, userId: string): Promise<string> {
  const bases = await db.listKnowledgeBases(userId)
  if (bases.length === 0) return ''
  const lines = bases.map(
    (base) => `- ${base.name}（${base.docCount} 篇文档 / ${base.chunkCount} 个片段）`
  )
  return [
    '',
    '',
    '## 知识库',
    '用户导入了以下资料。涉及这些主题的问题，先用 search_knowledge 工具检索，',
    '再基于检索到的原文回答；检索结果里没有的内容不要当成资料内容。',
    ...lines
  ].join('\n')
}
