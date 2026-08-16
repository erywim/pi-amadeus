import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Channel } from '@pi-amadeus/shared'
import type { BrainConfig } from '../config.ts'
import type { LlmTarget } from '../llm.ts'
import { createBashTool } from './bash.ts'
import { createCalculateTool } from './calculate.ts'
import { createSearchTool } from './search.ts'
import { createTimeTool } from './time.ts'
import { createWeatherTool } from './weather.ts'

/**
 * 工具注册表工厂（仿 coding 模块的 factory 模式）：
 * 按渠道组装 AgentTool 列表——desktop 含 bash（有确认卡通道），
 * feishu 排除 bash（v1 无交互确认通道）。后续新增工具（如 read_file）
 * 只需在对应渠道组里加一行。
 */

export interface ToolRegistryOptions {
  cfg: BrainConfig
  channel: Channel
  target: LlmTarget
  /** 由 agentTurn 提供：请求 bash 确认并把 tool_confirm 事件推入 SSE 队列 */
  confirmRequest: (toolCallId: string, command: string) => Promise<boolean>
}

export function buildToolRegistry(opts: ToolRegistryOptions): AgentTool[] {
  const proxy = opts.target.proxy || ''
  const tools: AgentTool[] = [
    createTimeTool(),
    createCalculateTool(),
    createWeatherTool({ proxy }),
    createSearchTool({ tavilyKey: opts.cfg.tools.tavilyKey || undefined, proxy })
  ]
  if (opts.channel === 'desktop') {
    tools.push(
      createBashTool({
        cwd: opts.cfg.tools.bashCwd,
        confirmRequest: opts.confirmRequest
      })
    )
  }
  return tools
}
