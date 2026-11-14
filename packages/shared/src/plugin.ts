/**
 * 插件体系（参考 DeepSeek Harness「万物皆插件」的生态形态）：
 * 一个插件就是一份可安装、可启停的能力包。当前支持四类：
 * - skill：SKILL.md 能力包，装进大脑的 skills 目录，由模型按需调用
 * - prompt：快捷指令模板，出现在输入框的指令菜单里
 * - theme：界面主题（CSS 变量包）
 * - mcp：MCP 服务（stdio），把外部工具接进 agent 的工具循环
 *
 * 目录（catalog）是内置的可发现列表；已安装条目落在大脑 SQLite 的 plugins 表。
 */

export type PluginKind = 'skill' | 'prompt' | 'theme' | 'mcp'

/** MCP 服务的受控高风险能力标记；只由内置目录项声明。 */
export type McpCapability = 'computer-use'

/** MCP 安装时向用户收集的字段：追加到启动参数或环境变量 */
export interface PluginField {
  key: string
  label: string
  hint?: string
  required?: boolean
  /** 密钥类字段：界面不回显，落库后只显示是否已配置 */
  secret?: boolean
  target: 'arg' | 'env'
  default?: string
}

export interface McpPreset {
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  fields?: PluginField[]
  capabilities?: McpCapability[]
}

export interface CatalogEntry {
  id: string
  kind: PluginKind
  name: string
  description: string
  /** 详情弹窗里的长说明（支持换行） */
  details?: string
  author: string
  version: string
  category: string
  tags: string[]
  /** emoji 图标（不引入图标库依赖，目录数据保持纯文本） */
  icon: string
  /** 卡片装饰色（CSS 渐变起点） */
  accent?: string
  homepage?: string
  /** skill：完整 SKILL.md（含 YAML frontmatter） */
  skillMarkdown?: string
  /** prompt：模板正文 */
  prompt?: string
  /** theme：CSS 变量表 */
  themeVars?: Record<string, string>
  /** mcp：启动方式 */
  mcp?: McpPreset
}

/** MCP 服务的实时状态（每次列插件时由大脑重新探测，不落库） */
export interface McpServerStatus {
  state: 'connected' | 'connecting' | 'error' | 'disabled'
  tools: string[]
  error?: string
  lastConnectedAt?: number
}

export interface InstalledPlugin {
  id: string
  kind: PluginKind
  name: string
  enabled: boolean
  installedAt: number
  /** skill: { dir } / prompt: { prompt } / theme: { vars } / mcp: { command, args, env, capabilities } */
  config: Record<string, unknown>
  /** 仅 mcp */
  status?: McpServerStatus
}

export interface PluginListResponse {
  installed: InstalledPlugin[]
  catalog: CatalogEntry[]
  /** skill 安装目录（打开目录用） */
  skillsDir: string
}

export interface PluginInstallInput {
  /** mcp 安装时用户填写的字段值（key → value） */
  fields?: Record<string, string>
}

// ---------- 数据看板 ----------

export interface StatsTotals {
  sessions: number
  messages: number
  turns: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface StatsDayPoint {
  /** YYYY-MM-DD（本地时区） */
  day: string
  turns: number
  toolCalls: number
  tokens: number
}

export interface StatsResponse {
  totals: StatsTotals
  /** 最近 14 天，按天升序（没有回合的日期补 0） */
  series: StatsDayPoint[]
  channels: { channel: string; count: number }[]
  models: { model: string; turns: number; tokens: number }[]
  /** 按模型服务（provider）聚合的回合与 token：只有真实产生过回合的服务才会出现 */
  providers: { name: string; turns: number; tokens: number }[]
  tools: { name: string; count: number }[]
  plugins: { total: number; enabled: number; byKind: Record<PluginKind, number> }
  /** 长期记忆条数（真实提取结果） */
  memories: number
  /** 好感度：真实互动事件累计 */
  affinity: { score: number; stageKey: string }
}

export const PLUGIN_KINDS: readonly PluginKind[] = ['skill', 'prompt', 'theme', 'mcp']
