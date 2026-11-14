/**
 * 本地工作区浏览（只读）：文件树 / 文件正文 / Git 状态与差异。
 *
 * 路径一律是相对工作区根目录的 POSIX 路径；服务端拒绝任何越界路径。
 * 这是「看」的接口，不提供写入——避免把浏览面板变成第二个不受确认的编辑器。
 */

export interface WorkspaceInfo {
  /** 工作区绝对路径（仅本地界面展示） */
  root: string
  /** 根目录名（面包屑起点） */
  name: string
  isRepo: boolean
  /** 当前分支；非 Git 目录为空串 */
  branch: string
}

export interface WorkspaceEntry {
  /** 相对路径，POSIX 分隔符 */
  path: string
  name: string
  kind: 'dir' | 'file'
  /** 相对根目录的层级，0 = 顶层 */
  depth: number
}

export interface WorkspaceFile {
  path: string
  name: string
  content: string
  /** 字节数 */
  size: number
  /** 超过服务端读取上限，content 仅含前段 */
  truncated: boolean
  /** 二进制文件：content 为空，界面显示占位而不是乱码 */
  binary: boolean
  /** 供界面显示的粗粒度语言标记（扩展名推断） */
  language: string
}

export interface WorkspaceGitFile {
  path: string
  /** 重命名前的路径 */
  origPath?: string
  /** porcelain 状态码（?? / M / A / D / R …） */
  status: string
  /** 有已暂存部分 */
  staged: boolean
}

export interface WorkspaceGitStatus {
  isRepo: boolean
  branch: string
  files: WorkspaceGitFile[]
  changedCount: number
}

export interface WorkspaceDiff {
  path: string
  diff: string
  truncated: boolean
  binary: boolean
  /** 未跟踪文件：diff 由文件正文合成（整份都是新增行） */
  untracked: boolean
}

export interface WorkspaceSearchHit {
  path: string
  name: string
  /** 所在目录；根目录为空串 */
  dir: string
}
