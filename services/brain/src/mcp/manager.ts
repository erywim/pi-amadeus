import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { McpServerStatus } from '@pi-amadeus/shared'
import { Type } from 'typebox'
import { McpStdioClient, type McpServerSpec, type McpTool } from './client.ts'

/** 单条 MCP 文本结果进入 LLM 上下文前的上限（超出截断，避免撑爆上下文） */
const RESULT_TEXT_LIMIT = 8000
const TOOL_NAME_MAX = 64

/**
 * MCP 服务生命周期管理：按插件配置连接、列工具、调用、断开。
 *
 * 连接是「尽力而为」：一个服务起不来只影响它自己的状态（status.error），
 * 不会拖垮其它插件，也不阻塞回合——工具列表取当前已连上的那部分。
 */
export class McpManager {
  private clients = new Map<string, McpStdioClient>()
  private tools = new Map<string, McpTool[]>()
  private statuses = new Map<string, McpServerStatus>()
  private specs = new Map<string, McpServerSpec>()
  /** 串行化 sync：安装/启停/启动可能同时触发，避免同一服务被并发拉起 */
  private queue: Promise<void> = Promise.resolve()

  /** 与期望的启用列表对齐：断开被移除/配置变化的，连上新出现的 */
  sync(specs: McpServerSpec[]): Promise<void> {
    this.queue = this.queue
      .then(() => this.doSync(specs))
      .catch((error) => {
        console.warn('[mcp] 同步失败：', error instanceof Error ? error.message : error)
      })
    return this.queue
  }

  private async doSync(specs: McpServerSpec[]): Promise<void> {
    const next = new Map(specs.map((spec) => [spec.id, spec]))
    for (const [id, client] of [...this.clients]) {
      const spec = next.get(id)
      if (!spec || fingerprint(spec) !== fingerprint(client.spec)) {
        client.close()
        this.clients.delete(id)
        this.tools.delete(id)
        this.statuses.delete(id)
      }
    }
    const pending = specs.filter((spec) => !this.clients.has(spec.id))
    // 并行连接：各自有超时，互不阻塞
    await Promise.all(pending.map((spec) => this.connect(spec)))
  }

  async connect(spec: McpServerSpec): Promise<void> {
    this.specs.set(spec.id, spec)
    this.statuses.set(spec.id, { state: 'connecting', tools: [] })
    const client = new McpStdioClient(spec)
    try {
      await client.connect()
      const tools = await client.listTools()
      this.clients.set(spec.id, client)
      this.tools.set(spec.id, tools)
      this.statuses.set(spec.id, {
        state: 'connected',
        tools: tools.map((tool) => tool.name),
        lastConnectedAt: Date.now()
      })
    } catch (error) {
      client.close()
      this.clients.delete(spec.id)
      this.tools.delete(spec.id)
      this.statuses.set(spec.id, {
        state: 'error',
        tools: [],
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  disconnect(id: string): void {
    this.clients.get(id)?.close()
    this.clients.delete(id)
    this.tools.delete(id)
    this.statuses.delete(id)
    this.specs.delete(id)
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
    this.tools.clear()
    this.statuses.clear()
    this.specs.clear()
  }

  statusOf(id: string): McpServerStatus | undefined {
    return this.statuses.get(id)
  }

  /** 当前已连接服务的工具数（看板用） */
  connectedServerCount(): number {
    return this.clients.size
  }

  /**
   * 把已连接服务的工具包成 AgentTool。
   * 每次回合调用时重新生成：工具名带服务前缀，避免不同服务同名工具互相覆盖。
   */
  listAgentTools(): AgentTool[] {
    const result: AgentTool[] = []
    for (const [serverId, tools] of this.tools) {
      const serverName = this.specs.get(serverId)?.name ?? serverId
      for (const tool of tools) {
        result.push(this.toAgentTool(serverId, serverName, tool))
      }
    }
    return result
  }

  private toAgentTool(serverId: string, serverName: string, tool: McpTool): AgentTool {
    const name = agentToolName(serverId, tool.name)
    const schema = (tool.inputSchema ?? { type: 'object', properties: {} }) as object
    return {
      name,
      label: `${serverName} · ${tool.name}`,
      description: tool.description || `MCP 工具 ${tool.name}（来自 ${serverName}）`,
      // MCP 给的是 JSON Schema；Type.Unsafe 原样透传给模型，不做 TypeBox 重建
      parameters: Type.Unsafe(schema),
      execute: async (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
        const args = (params ?? {}) as Record<string, unknown>
        const result = await this.callTool(serverId, tool.name, args)
        const blocks = result.content
          .map((block) => {
            if (block.type === 'text') {
              return { type: 'text' as const, text: truncate(block.text ?? '', RESULT_TEXT_LIMIT) }
            }
            if (block.type === 'image' && block.data) {
              return {
                type: 'image' as const,
                data: block.data,
                mimeType: block.mimeType ?? 'image/png'
              }
            }
            return null
          })
          .filter((block): block is NonNullable<typeof block> => block !== null)
        const text = blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        if (result.isError) throw new Error(text || `MCP 工具 ${tool.name} 返回错误`)
        return {
          // 类型收窄：pi 的 content 联合与 MCP 的块结构一致，空结果给一句占位
          content: blocks.length > 0 ? (blocks as AgentToolResult<unknown>['content']) : [{ type: 'text', text: '（无输出）' }],
          details: { serverId, serverName, tool: tool.name, structured: result.structuredContent }
        }
      }
    }
  }

  private async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<Awaited<ReturnType<McpStdioClient['callTool']>>> {
    const client = this.clients.get(serverId)
    if (!client) throw new Error(`MCP 服务 ${serverId} 未连接`)
    return client.callTool(toolName, args)
  }
}

function fingerprint(spec: McpServerSpec): string {
  return JSON.stringify([spec.command, spec.args, spec.env ?? {}])
}

/** 工具名只允许字母数字下划线短横线；超长截断（前缀已保证同一服务内不重名） */
export function agentToolName(serverId: string, toolName: string): string {
  const raw = `mcp_${serverId}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  return raw.length <= TOOL_NAME_MAX ? raw : raw.slice(0, TOOL_NAME_MAX)
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断）`
}

/** 进程级单例：一个 brain 进程只服务一套插件配置（与 skills 目录同前提） */
export const mcpManager = new McpManager()
