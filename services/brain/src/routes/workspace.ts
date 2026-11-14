import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import {
  readWorkspaceFile,
  searchWorkspaceFiles,
  workspaceDiff,
  workspaceGit,
  workspaceInfo,
  workspaceTree
} from '../workspace.ts'

/**
 * 只读工作区浏览：文件树 / 文件正文 / Git 状态与差异 / 文件名搜索。
 * 根目录由 WORKSPACE_DIR 指定（默认与 bash 工具 cwd 一致），不做任何写入。
 */
export function workspaceRoutes(cfg: BrainConfig): Hono {
  const app = new Hono()
  const root = cfg.workspace.root

  const fail = (c: { json: (body: unknown, status: 400 | 404 | 500) => Response }, error: unknown): Response => {
    const message = error instanceof Error ? error.message : String(error)
    const status = /越界|不是文件|ENOENT|no such file/i.test(message) ? 404 : 400
    return c.json({ error: message }, status)
  }

  app.get('/workspace/info', async (c) => {
    try {
      return c.json(await workspaceInfo(root))
    } catch (error) {
      return fail(c, error)
    }
  })

  app.get('/workspace/tree', async (c) => {
    try {
      return c.json({ root, entries: await workspaceTree(root) })
    } catch (error) {
      return fail(c, error)
    }
  })

  app.get('/workspace/file', async (c) => {
    const path = c.req.query('path') ?? ''
    if (!path) return c.json({ error: 'path 必填' }, 400)
    try {
      return c.json(await readWorkspaceFile(root, path))
    } catch (error) {
      return fail(c, error)
    }
  })

  app.get('/workspace/git', async (c) => {
    try {
      return c.json(await workspaceGit(root))
    } catch (error) {
      return fail(c, error)
    }
  })

  app.get('/workspace/diff', async (c) => {
    const path = c.req.query('path') ?? ''
    if (!path) return c.json({ error: 'path 必填' }, 400)
    try {
      return c.json(await workspaceDiff(root, path))
    } catch (error) {
      return fail(c, error)
    }
  })

  app.get('/workspace/search', async (c) => {
    const query = c.req.query('q') ?? ''
    if (!query.trim()) return c.json({ hits: [] })
    try {
      return c.json({ hits: await searchWorkspaceFiles(root, query) })
    } catch (error) {
      return fail(c, error)
    }
  })

  return app
}
