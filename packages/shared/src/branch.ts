import type { Role } from './session.ts'

/**
 * 消息分支树的完整快照（不是当前路径）。
 * 编辑用户消息 / 重新生成会在同一父节点下产生兄弟节点；active 标出当前活跃路径，
 * 点击任意节点 = 把活跃叶切到该分支的最新后代。
 */
export interface BranchTreeNode {
  id: string
  parentId: string | null
  role: Role
  /** 单行预览（已折叠空白，最多约 100 字） */
  preview: string
  createdAt: number
  branchIndex: number
  branchCount: number
  /** 是否在当前活跃路径上 */
  active: boolean
}

export interface BranchTreeResponse {
  activeLeafId: string | null
  nodes: BranchTreeNode[]
}
