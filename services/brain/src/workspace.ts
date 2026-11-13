import { execFile } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceGitFile,
  WorkspaceGitStatus,
  WorkspaceInfo,
  WorkspaceSearchHit
} from '@pi-amadeus/shared'

const execFileAsync = promisify(execFile)

const MAX_TREE_NODES = 1500
const MAX_TREE_DEPTH = 7
const MAX_FILES = 8000
const MAX_READ_BYTES = 512 * 1024
const MAX_DIFF_BYTES = 512 * 1024
const GIT_TIMEOUT_MS = 8_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** 目录遍历时直接跳过的重型目录（有 Git 时以 .gitignore 为准） */
const WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  'release',
  'release-local',
  '.next',
  '.turbo',
  '.cache',
  '.multica',
  'data'
])

/** 不通过只读浏览接口暴露的敏感文件 */
const SENSITIVE_FILE =
  /^(\.env(\..*)?|id_rsa|id_ed25519|.*\.(pem|key|p12|pfx|keystore))$/i

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.xml': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
  '.zsh': 'shell',
  '.bash': 'shell',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.sql': 'sql',
  '.svg': 'svg',
  '.txt': 'text'
}

function isSafeRelative(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\0')) return false
  return !value.split('/').some((part) => part === '..')
}

function isSensitive(relPath: string): boolean {
  return relPath.split('/').some((part) => SENSITIVE_FILE.test(part))
}

/** 运行时目录不属于用户工作区内容（数据库、任务上下文等） */
function isInternal(relPath: string): boolean {
  return relPath === '.multica' || relPath.startsWith('.multica/')
}

function normalizeGitPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER
  })
  return stdout
}

async function tryGit(root: string, args: string[]): Promise<string | null> {
  try {
    return await git(root, args)
  } catch {
    return null
  }
}

/**
 * 工作区文件清单：优先用 `git ls-files`（天然尊从 .gitignore，也包含未跟踪文件），
 * 不是 Git 仓库时回退到有界的目录遍历。
 */
async function listWorkspaceFiles(root: string): Promise<string[]> {
  const gited = await tryGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (gited !== null) {
    const seen = new Set<string>()
    for (const item of gited.split('\0')) {
      const path = normalizeGitPath(item)
      if (isSafeRelative(path) && !isSensitive(path) && !isInternal(path)) seen.add(path)
    }
    return [...seen].slice(0, MAX_FILES)
  }
  return walkFiles(root, '', 0, [])
}

async function walkFiles(
  root: string,
  relativeDir: string,
  depth: number,
  out: string[]
): Promise<string[]> {
  if (depth > MAX_TREE_DEPTH || out.length >= MAX_FILES) return out
  let entries
  try {
    entries = await readdir(resolve(root, relativeDir), { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break
    const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walkFiles(root, rel, depth + 1, out)
    } else if (entry.isFile() && !isSensitive(rel)) {
      out.push(rel)
    }
  }
  return out
}

export async function workspaceInfo(root: string): Promise<WorkspaceInfo> {
  const isRepo = (await tryGit(root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
  let branch = ''
  if (isRepo) {
    branch =
      (await tryGit(root, ['symbolic-ref', '--short', 'HEAD']))?.trim() ||
      (await tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ||
      ''
  }
  return { root, name: basename(root) || root, isRepo, branch }
}

/** 文件树（扁平化 + 深度标记，前端按 depth 缩进即可） */
export async function workspaceTree(root: string): Promise<WorkspaceEntry[]> {
  const files = await listWorkspaceFiles(root)
  const childDirs = new Map<string, Set<string>>()
  const filesInDir = new Map<string, string[]>()

  for (const file of files) {
    const parts = file.split('/')
    let dir = ''
    for (let index = 0; index < parts.length - 1; index += 1) {
      const next = dir ? `${dir}/${parts[index]}` : parts[index]!
      const set = childDirs.get(dir) ?? new Set<string>()
      set.add(parts[index]!)
      childDirs.set(dir, set)
      dir = next
    }
    const list = filesInDir.get(dir) ?? []
    list.push(file)
    filesInDir.set(dir, list)
  }

  const entries: WorkspaceEntry[] = []
  const walk = (dir: string, depth: number): void => {
    if (entries.length >= MAX_TREE_NODES || depth > MAX_TREE_DEPTH) return
    const dirs = [...(childDirs.get(dir) ?? [])].sort((a, b) => a.localeCompare(b))
    for (const name of dirs) {
      if (entries.length >= MAX_TREE_NODES) return
      const path = dir ? `${dir}/${name}` : name
      entries.push({ path, name, kind: 'dir', depth })
      walk(path, depth + 1)
    }
    const filesHere = (filesInDir.get(dir) ?? []).sort((a, b) => a.localeCompare(b))
    for (const path of filesHere) {
      if (entries.length >= MAX_TREE_NODES) return
      entries.push({ path, name: basename(path), kind: 'file', depth })
    }
  }
  walk('', 0)
  return entries
}

/** 相对路径 → 绝对路径，拒绝越界（词法 + 符号链接两层校验） */
async function resolveInside(root: string, relativePath: string): Promise<string> {
  const rel = normalizeGitPath(relativePath)
  if (!isSafeRelative(rel)) throw new Error('路径越界')
  const full = resolve(root, rel)
  if (full !== root && !full.startsWith(root + sep)) throw new Error('路径越界')
  const realRoot = await realpath(root).catch(() => root)
  const realFull = await realpath(full).catch(() => full)
  if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) throw new Error('路径越界')
  return full
}

export async function readWorkspaceFile(root: string, relativePath: string): Promise<WorkspaceFile> {
  const full = await resolveInside(root, relativePath)
  const info = await stat(full)
  if (!info.isFile()) throw new Error('不是文件')
  const size = info.size
  const readBytes = Math.min(size, MAX_READ_BYTES)
  const handle = await open(full, 'r')
  let buffer: Buffer
  try {
    buffer = Buffer.alloc(readBytes)
    const { bytesRead } = await handle.read(buffer, 0, readBytes, 0)
    buffer = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const binary = buffer.subarray(0, 8192).includes(0)
  const path = normalizeGitPath(relativePath)
  return {
    path,
    name: basename(path),
    content: binary ? '' : buffer.toString('utf8'),
    size,
    truncated: size > MAX_READ_BYTES,
    binary,
    language: LANGUAGE_BY_EXT[extname(path).toLowerCase()] ?? 'text'
  }
}

/**
 * 回合级变更快照：path → 状态码。非 Git 仓库/命令失败返回 null
 * （null 表示「不知道」，绝不与「没有变化」混为一谈）。
 */
export async function gitSnapshot(root: string): Promise<Map<string, string> | null> {
  const inside = (await tryGit(root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
  if (!inside) return null
  const raw = await tryGit(root, ['status', '--porcelain=v1', '-z', '-uall'])
  if (raw === null) return null
  const snapshot = new Map<string, string>()
  const tokens = raw.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.length < 4) continue
    const code = token.slice(0, 2)
    const path = normalizeGitPath(token.slice(3))
    if (code.includes('R') || code.includes('C')) index += 1
    if (!isSafeRelative(path) || isSensitive(path) || isInternal(path)) continue
    snapshot.set(path, code.trim() || '??')
  }
  return snapshot
}

/**
 * 两次快照的差集：回合期间新出现或状态变化的文件。
 * before 为 null（回合开始时还不知道）时不报任何改动——宁缺勿假。
 */
export function diffSnapshots(
  before: Map<string, string> | null,
  after: Map<string, string> | null
): Array<{ path: string; status: string }> {
  if (!before || !after) return []
  const changed: Array<{ path: string; status: string }> = []
  for (const [path, status] of after) {
    if (before.get(path) !== status) changed.push({ path, status })
  }
  changed.sort((a, b) => a.path.localeCompare(b.path))
  return changed.slice(0, 60)
}

export async function workspaceGit(root: string): Promise<WorkspaceGitStatus> {
  const inside = (await tryGit(root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
  if (!inside) return { isRepo: false, branch: '', files: [], changedCount: 0 }
  const info = await workspaceInfo(root)
  // -uall：未跟踪目录展开成具体文件，避免列表出现无法打开 diff 的 `.dir/` 项
  const raw = (await tryGit(root, ['status', '--porcelain=v1', '-z', '-uall'])) ?? ''
  const tokens = raw.split('\0')
  const files: WorkspaceGitFile[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.length < 4) continue
    const code = token.slice(0, 2)
    const path = normalizeGitPath(token.slice(3))
    if (!isSafeRelative(path) || isSensitive(path) || isInternal(path)) continue
    let origPath: string | undefined
    // 重命名/复制：-z 格式里原路径是紧随其后的独立 token
    if (code.includes('R') || code.includes('C')) {
      const original = tokens[index + 1]
      if (original) {
        origPath = normalizeGitPath(original)
        index += 1
      }
    }
    files.push({
      path,
      ...(origPath ? { origPath } : {}),
      status: code.trim() || '??',
      staged: code[0] !== ' ' && code[0] !== '?'
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { isRepo: true, branch: info.branch, files, changedCount: files.length }
}

/** 未跟踪文件合成一份「整份新增」的 diff，避免面板对 ?? 文件空着 */
async function synthesizeUntrackedDiff(root: string, path: string): Promise<WorkspaceDiff> {
  const file = await readWorkspaceFile(root, path).catch(() => null)
  if (!file) {
    return { path, diff: '', truncated: false, binary: true, untracked: true }
  }
  if (file.binary) return { path, diff: '', truncated: false, binary: true, untracked: true }
  const lines = file.content.split('\n')
  const body = lines
    .slice(0, 4000)
    .map((line) => `+${line}`)
    .join('\n')
  return {
    path,
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
    truncated: file.truncated || lines.length > 4000,
    binary: false,
    untracked: true
  }
}

export async function workspaceDiff(root: string, relativePath: string): Promise<WorkspaceDiff> {
  const path = normalizeGitPath(relativePath)
  await resolveInside(root, path)
  const tracked = (await tryGit(root, ['ls-files', '--error-unmatch', '--', path])) !== null
  if (!tracked) return synthesizeUntrackedDiff(root, path)

  let diff = (await tryGit(root, ['diff', '--no-color', '--unified=3', 'HEAD', '--', path])) ?? ''
  if (!diff) {
    // 还没有首个提交：HEAD 不存在，分别看暂存区与工作区
    const staged = (await tryGit(root, ['diff', '--no-color', '--unified=3', '--cached', '--', path])) ?? ''
    const unstaged = (await tryGit(root, ['diff', '--no-color', '--unified=3', '--', path])) ?? ''
    diff = `${staged}${unstaged}`
  }
  const binary = /^Binary files /m.test(diff)
  return {
    path,
    diff: binary ? '' : diff.slice(0, MAX_DIFF_BYTES),
    truncated: diff.length > MAX_DIFF_BYTES,
    binary,
    untracked: false
  }
}

export async function searchWorkspaceFiles(root: string, query: string): Promise<WorkspaceSearchHit[]> {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return []
  const files = await listWorkspaceFiles(root)
  const scored: Array<{ file: string; score: number }> = []
  for (const file of files) {
    const lower = file.toLowerCase()
    const name = basename(lower)
    let score = 0
    if (name === keyword) score = 100
    else if (name.startsWith(keyword)) score = 80
    else if (name.includes(keyword)) score = 60
    else if (lower.includes(keyword)) score = 30
    if (score === 0) continue
    scored.push({ file, score })
  }
  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length)
  return scored.slice(0, 40).map(({ file }) => {
    const slash = file.lastIndexOf('/')
    return {
      path: file,
      name: slash >= 0 ? file.slice(slash + 1) : file,
      dir: slash >= 0 ? file.slice(0, slash) : ''
    }
  })
}
