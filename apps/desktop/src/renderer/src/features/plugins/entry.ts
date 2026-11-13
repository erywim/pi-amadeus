import type { CatalogEntry, InstalledPlugin } from '@pi-amadeus/shared'

/** 已安装但不在目录里的插件（自定义 MCP）：补一份卡片所需的元数据 */
export function entryOf(plugin: InstalledPlugin, catalog: CatalogEntry[]): CatalogEntry {
  return (
    catalog.find((entry) => entry.id === plugin.id) ?? {
      id: plugin.id,
      kind: plugin.kind,
      name: plugin.name,
      description: '',
      author: '本地',
      version: '—',
      category: '自定义',
      tags: [],
      icon: plugin.kind === 'mcp' ? '🔌' : '🧩',
      accent: '#64748b'
    }
  )
}
