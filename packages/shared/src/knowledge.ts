/**
 * 知识库（参考 开源桌面客户端（A） / 开源工作区客户端（A） / 开源自托管客户端（B））：
 * 用户导入的文档被切成块存进 SQLite，回合里由 search_knowledge 工具检索。
 * 检索结果是真实导入的文本片段，不生成、不补全、不伪造引用。
 */

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  /** 文档数 / 分块数（来自数据库统计） */
  docCount: number
  chunkCount: number
  createdAt: number
  updatedAt: number
}

export interface KnowledgeDoc {
  id: string
  kbId: string
  name: string
  /** 来源说明：手动粘贴 / 文件名 / URL */
  source: string
  chars: number
  chunks: number
  createdAt: number
}

export interface KnowledgeSearchHit {
  chunkId: string
  docId: string
  docName: string
  kbId: string
  kbName: string
  /** 命中的原文片段（含上下文，未改写） */
  content: string
  /** 相关度分数（词频 × 逆文档频率，仅用于排序） */
  score: number
}

export interface KnowledgeListResponse {
  bases: KnowledgeBase[]
  /** 全局文档与分块总数（跨知识库） */
  totals: { docs: number; chunks: number }
}

export interface KnowledgeBaseInput {
  name: string
  description?: string
}

/** 导入文档：content 是原始文本，name 是展示名，source 说明来源 */
export interface KnowledgeDocInput {
  name: string
  content: string
  source?: string
}
