import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CatalogEntry, InstalledPlugin, McpCapability } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import type { Db, PluginRow } from '../db.ts'
import { mcpManager } from '../mcp/manager.ts'
import type { McpServerSpec } from '../mcp/client.ts'
import { PLUGIN_CATALOG, findCatalogEntry } from './catalog.ts'

/**
 * 插件注册表：安装 / 卸载 / 启停，以及把已安装的 MCP 插件同步给运行时。
 *
 * 状态以 SQLite `plugins` 表为准；skill 的正文仍写进 skills 目录（pi 的加载器只认文件），
 * prompt / theme / mcp 的配置直接存在 plugins.config 里。
 */

export type PluginActionResult =
  | { ok: true; plugin: InstalledPlugin }
  | { ok: false; code: 'notFound' | 'conflict' | 'badRequest' | 'io'; message: string }

function catalogOf(id: string): CatalogEntry | undefined {
  return findCatalogEntry(id)
}

function toInstalled(row: PluginRow): InstalledPlugin {
  const plugin: InstalledPlugin = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    installedAt: row.installedAt,
    config: row.config
  }
  if (row.kind === 'mcp') {
    const env = row.config.env
    // API 只返回变量名与配置状态；复制配置，不能把数据库/运行时的活凭证改成脱敏值。
    plugin.config = {
      ...row.config,
      env: Object.fromEntries(
        Object.entries(env && typeof env === 'object' && !Array.isArray(env) ? env : {}).map(
          ([key, value]) => [key, typeof value === 'string' && value.length > 0]
        )
      )
    }
    plugin.status = row.enabled
      ? (mcpManager.statusOf(row.id) ?? { state: 'connecting', tools: [] })
      : { state: 'disabled', tools: [] }
  }
  return plugin
}

export async function listInstalled(db: Db): Promise<InstalledPlugin[]> {
  const rows = await db.listPlugins()
  return rows.map(toInstalled)
}

/** 插件目录 + 已安装列表（发现页与已安装页共用一次请求） */
export async function listPluginCenter(
  cfg: BrainConfig,
  db: Db
): Promise<{ installed: InstalledPlugin[]; catalog: CatalogEntry[]; skillsDir: string }> {
  return {
    installed: await listInstalled(db),
    catalog: PLUGIN_CATALOG,
    skillsDir: cfg.skills.dir
  }
}

/** 已启用的 MCP 插件 → 运行时配置（供 mcpManager.sync 使用） */
export async function mcpSpecsOf(db: Db): Promise<McpServerSpec[]> {
  const rows = await db.listPlugins()
  const specs: McpServerSpec[] = []
  for (const row of rows) {
    if (row.kind !== 'mcp' || !row.enabled) continue
    const command = typeof row.config.command === 'string' ? row.config.command : ''
    if (!command) continue
    const args = Array.isArray(row.config.args)
      ? row.config.args.filter((arg): arg is string => typeof arg === 'string')
      : []
    const env =
      row.config.env && typeof row.config.env === 'object' && !Array.isArray(row.config.env)
        ? Object.fromEntries(
            Object.entries(row.config.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : undefined
    const capabilities = Array.isArray(row.config.capabilities)
      ? row.config.capabilities.filter((value): value is McpCapability => value === 'computer-use')
      : undefined
    specs.push({ id: row.id, name: row.name, command, args, env, capabilities })
  }
  return specs
}

export async function syncMcpPlugins(db: Db): Promise<void> {
  await mcpManager.sync(await mcpSpecsOf(db))
}

/** 被插件禁用的 skill 名（skills 加载器据此过滤；未安装为插件的 skill 不受影响） */
export async function disabledSkillNames(db: Db): Promise<Set<string>> {
  const rows = await db.listPlugins()
  const disabled = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'skill' || row.enabled) continue
    const name = typeof row.config.skillName === 'string' ? row.config.skillName : row.name
    disabled.add(name)
  }
  return disabled
}

export async function installPlugin(
  cfg: BrainConfig,
  db: Db,
  id: string,
  fields: Record<string, string> = {}
): Promise<PluginActionResult> {
  const entry = catalogOf(id)
  if (!entry) return { ok: false, code: 'notFound', message: '插件不存在' }
  const existing = await db.getPlugin(id)
  if (existing) return { ok: false, code: 'conflict', message: '插件已安装' }

  if (entry.kind === 'skill') {
    if (!entry.skillMarkdown) {
      return { ok: false, code: 'badRequest', message: '插件缺少 skill 正文' }
    }
    const dir = safeSkillDir(cfg, id)
    if (!dir) return { ok: false, code: 'badRequest', message: '非法的 skill id' }
    if (existsSync(dir)) {
      return { ok: false, code: 'conflict', message: `目标目录已存在：${dir}` }
    }
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), entry.skillMarkdown, 'utf8')
    } catch (error) {
      // 半截目录会让后续安装永远冲突：失败时清掉本次创建的目录
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败随原始错误一起上报 */
      }
      return { ok: false, code: 'io', message: `写入 skill 失败：${error instanceof Error ? error.message : error}` }
    }
    const skillName = parseSkillName(entry.skillMarkdown) ?? id
    await db.upsertPlugin({
      id,
      kind: 'skill',
      name: entry.name,
      enabled: true,
      config: { dir, skillName }
    })
    return { ok: true, plugin: toInstalled((await db.getPlugin(id))!) }
  }

  if (entry.kind === 'prompt') {
    if (!entry.prompt) return { ok: false, code: 'badRequest', message: '插件缺少指令模板' }
    await db.upsertPlugin({
      id,
      kind: 'prompt',
      name: entry.name,
      enabled: true,
      config: { prompt: entry.prompt }
    })
    return { ok: true, plugin: toInstalled((await db.getPlugin(id))!) }
  }

  if (entry.kind === 'theme') {
    if (!entry.themeVars || Object.keys(entry.themeVars).length === 0) {
      return { ok: false, code: 'badRequest', message: '插件缺少主题变量' }
    }
    await db.upsertPlugin({
      id,
      kind: 'theme',
      name: entry.name,
      enabled: true,
      config: { vars: entry.themeVars }
    })
    return { ok: true, plugin: toInstalled((await db.getPlugin(id))!) }
  }

  // mcp
  const preset = entry.mcp
  if (!preset) return { ok: false, code: 'badRequest', message: '插件缺少 MCP 启动配置' }
  const args = [...preset.args]
  const env: Record<string, string> = { ...(preset.env ?? {}) }
  const capabilities = preset.capabilities?.filter((capability): capability is McpCapability => capability === 'computer-use')
  for (const field of preset.fields ?? []) {
    const raw = (fields[field.key] ?? field.default ?? '').trim()
    if (!raw) {
      if (field.required) {
        return { ok: false, code: 'badRequest', message: `请填写「${field.label}」` }
      }
      continue
    }
    if (field.target === 'env') env[field.key] = raw
    else args.push(raw)
  }
  await db.upsertPlugin({
    id,
    kind: 'mcp',
    name: entry.name,
    enabled: true,
    config: { transport: 'stdio', command: preset.command, args, env, capabilities }
  })
  // 安装即尝试连接：连不上不算安装失败（用户可能还需要装 npx/uv 或改配置）
  const spec: McpServerSpec = {
    id,
    name: entry.name,
    command: preset.command,
    args,
    env,
    capabilities
  }
  await mcpManager.connect(spec)
  return { ok: true, plugin: toInstalled((await db.getPlugin(id))!) }
}

/** 自定义 MCP 服务：目录之外的高级入口，同样落 plugins 表并接入工具循环 */
export async function addCustomMcp(
  db: Db,
  input: { name: string; command: string; args?: string[]; env?: Record<string, string> }
): Promise<PluginActionResult> {
  const name = input.name.trim()
  const command = input.command.trim()
  if (!name || !command) return { ok: false, code: 'badRequest', message: 'name 与 command 必填' }
  const id = `mcp-custom-${randomUUID()}`
  const args = (input.args ?? []).map((arg) => arg.trim()).filter(Boolean)
  const env = Object.fromEntries(
    Object.entries(input.env ?? {})
      .map(([key, value]) => [key.trim(), value] as const)
      .filter(([key, value]) => key && value)
  )
  await db.upsertPlugin({
    id,
    kind: 'mcp',
    name,
    enabled: true,
    config: { transport: 'stdio', command, args, env }
  })
  // 自定义 MCP 永远不获得 computer-use 能力标记，避免绕过内置安全门。
  await mcpManager.connect({ id, name, command, args, env })
  return { ok: true, plugin: toInstalled((await db.getPlugin(id))!) }
}

export async function uninstallPlugin(
  cfg: BrainConfig,
  db: Db,
  id: string
): Promise<{ ok: true; removed: true } | { ok: false; code: 'notFound' | 'io'; message: string }> {
  const row = await db.getPlugin(id)
  if (!row) return { ok: false, code: 'notFound', message: '插件未安装' }
  if (row.kind === 'skill') {
    const dir = typeof row.config.dir === 'string' ? row.config.dir : safeSkillDir(cfg, id)
    // 只删 skills 目录内、且由我们记录的安装目录：防止配置被篡改后误删任意路径
    if (dir && isInside(cfg.skills.dir, dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        return {
          ok: false,
          code: 'io',
          message: `删除 skill 目录失败：${error instanceof Error ? error.message : error}`
        }
      }
    }
  }
  if (row.kind === 'mcp') mcpManager.disconnect(id)
  await db.deletePlugin(id)
  return { ok: true, removed: true }
}

/** 重新拉起一个 MCP 服务（连接失败后的「重试」入口） */
export async function reconnectPlugin(db: Db, id: string): Promise<PluginActionResult> {
  const row = await db.getPlugin(id)
  if (!row) return { ok: false, code: 'notFound', message: '插件未安装' }
  if (row.kind !== 'mcp') {
    return { ok: false, code: 'badRequest', message: '只有 MCP 插件需要重连' }
  }
  mcpManager.disconnect(id)
  await syncMcpPlugins(db)
  return { ok: true, plugin: toInstalled((await db.getPlugin(id))!) }
}

export async function setPluginEnabled(
  db: Db,
  id: string,
  enabled: boolean
): Promise<PluginActionResult> {
  const row = await db.getPlugin(id)
  if (!row) return { ok: false, code: 'notFound', message: '插件未安装' }
  await db.setPluginEnabled(id, enabled)
  if (row.kind === 'mcp') await syncMcpPlugins(db)
  return { ok: true, plugin: toInstalled((await db.getPlugin(id))!) }
}

function safeSkillDir(cfg: BrainConfig, id: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null
  return join(cfg.skills.dir, id)
}

function parseSkillName(markdown: string): string | null {
  const match = /^---\s*[\s\S]*?^name:\s*(.+)$/m.exec(markdown)
  return match ? match[1]!.trim() : null
}

function isInside(parent: string, child: string): boolean {
  const parentPath = resolve(parent)
  const childPath = resolve(child)
  return childPath === parentPath ? false : childPath.startsWith(`${parentPath}/`)
}
