import type { MessageTreeNode } from './db.ts'

/**
 * 世界线计算（会话树上的纯函数）。
 *
 * 术语映射到《命运石之门》：
 * - 一条世界线 = 树上从根到某个叶子的一条路径
 * - 分叉 = 同一父节点下的第二个子节点（重新生成 / 回退后重说都会产生）
 * - 世界线跳跃 = 把活动叶切到另一条路径
 * - 变动率 = 由当前末端 id 稳定推导的展示值（同一世界线永远同一个数）
 */

/** 父节点 → 子节点（按创建时间、再按 id 稳定排序） */
function childrenOf(tree: MessageTreeNode[]): Map<string | null, MessageTreeNode[]> {
  const map = new Map<string | null, MessageTreeNode[]>()
  for (const node of tree) {
    const list = map.get(node.parentId) ?? []
    list.push(node)
    map.set(node.parentId, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  return map
}

/** 所有叶子：没有子节点的消息（按创建时间排序，决定世界线序号） */
export function leavesOf(tree: MessageTreeNode[]): MessageTreeNode[] {
  const hasChild = new Set<string>()
  for (const node of tree) {
    if (node.parentId) hasChild.add(node.parentId)
  }
  return tree
    .filter((node) => !hasChild.has(node.id))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 从某个节点往"最新"的分支走到底：同一分支上取创建时间最晚的子节点。
 * 用于"点兄弟切换世界线"时落到那条支路的最新状态。
 */
export function latestLeafUnder(tree: MessageTreeNode[], messageId: string): MessageTreeNode | null {
  const children = childrenOf(tree)
  let current: MessageTreeNode | undefined = tree.find((node) => node.id === messageId)
  if (!current) return null
  const seen = new Set<string>([current.id])
  for (;;) {
    const kids: MessageTreeNode[] = children.get(current.id) ?? []
    if (kids.length === 0) return current
    // 防止脏数据成环：见过的节点不再走
    const next = [...kids].reverse().find((kid) => !seen.has(kid.id))
    if (!next) return current
    seen.add(next.id)
    current = next
  }
}

/** 同一父节点下的所有兄弟 id（含自己，按创建时间排序） */
export function siblingIdsOf(tree: MessageTreeNode[], messageId: string): string[] {
  const node = tree.find((item) => item.id === messageId)
  if (!node) return [messageId]
  return (childrenOf(tree).get(node.parentId) ?? []).map((item) => item.id)
}

/**
 * 世界线变动率：由末端 id 稳定推导到 [1.000000, 1.999999]。
 * 只是主题展示值，不参与任何业务判断。
 */
export function divergenceOf(headId: string | null): number {
  if (!headId) return 1
  // FNV-1a 32 位：够散、够稳定、无需依赖
  let hash = 0x811c9dc5
  for (let i = 0; i < headId.length; i += 1) {
    hash ^= headId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return 1 + (hash % 1_000_000) / 1_000_000
}

export interface WorldlineState {
  headId: string | null
  index: number
  total: number
  divergence: number
  rewound: boolean
}

/**
 * 当前世界线状态：
 * - index 按"该末端所属的那条世界线"计算（回退到中途时仍显示原来那条）
 * - rewound = 末端还有子节点（停在中途）
 */
export function worldlineStateOf(tree: MessageTreeNode[], headId: string | null): WorldlineState {
  const leaves = leavesOf(tree)
  const total = leaves.length
  if (!headId) {
    return { headId: null, index: total === 0 ? 0 : 1, total, divergence: divergenceOf(null), rewound: false }
  }
  const node = tree.find((item) => item.id === headId)
  const rewound = node ? (childrenOf(tree).get(headId) ?? []).length > 0 : false
  const projected = rewound ? latestLeafUnder(tree, headId) : node
  const leafIndex = projected ? leaves.findIndex((leaf) => leaf.id === projected.id) : -1
  return {
    headId,
    index: leafIndex >= 0 ? leafIndex + 1 : total === 0 ? 0 : 1,
    total,
    divergence: divergenceOf(headId),
    rewound
  }
}

export interface WorldlineEntry {
  leafId: string
  index: number
  divergence: number
  updatedAt: number
  active: boolean
}

/** 世界线列表（跳转面板用）：每条世界线的叶子、序号、变动率、末端时间 */
export function worldlinesOf(tree: MessageTreeNode[], headId: string | null): WorldlineEntry[] {
  const leaves = leavesOf(tree)
  const projected = headId ? (worldlineStateOf(tree, headId).rewound ? latestLeafUnder(tree, headId) : tree.find((n) => n.id === headId)) : null
  return leaves.map((leaf, index) => ({
    leafId: leaf.id,
    index: index + 1,
    divergence: divergenceOf(leaf.id),
    updatedAt: leaf.createdAt,
    active: projected?.id === leaf.id
  }))
}
