import type { BrainConfig } from '../config.ts'
import type { SearchOptions } from './search.ts'

/** 工具与诊断共用实际出站配置；独立 SEARCH_PROXY 优先，显式空值表示直连。 */
export function searchOptions(cfg: Pick<BrainConfig, 'tools'>, modelProxy?: string, signal?: AbortSignal): SearchOptions {
  return {
    ...(cfg.tools.tavilyKey ? { tavilyKey: cfg.tools.tavilyKey } : {}),
    proxy: cfg.tools.searchProxy ?? modelProxy ?? '',
    endpoints: cfg.tools.searchEndpoints,
    ...(signal ? { signal } : {})
  }
}
