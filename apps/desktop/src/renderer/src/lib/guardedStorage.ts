import { createJSONStorage, type PersistStorage } from 'zustand/middleware'

/**
 * zustand persist 的防损坏 localStorage 层（包一层 createJSONStorage）：
 * - 解析成功：同步刷新一份 <key>.bak（last-good），供将来损坏时恢复；
 * - 解析失败：保留现场（损坏原文另存 <key>.bad-<ISO时间戳>），优先从 .bak 恢复；
 *   恢复不可用才回 null，由 persist 走初始默认值——绝不静默用默认值覆盖损坏现场。
 * 备份/另存的写入失败（如配额满）不阻断主流程。健康路径行为与默认 storage 完全一致。
 */
export function createGuardedJsonStorage<T>(tag: string): PersistStorage<T> {
  const jsonStorage = createJSONStorage<T>(() => localStorage)
  return {
    getItem: (name) => {
      // 从未持久化过：与默认 storage 一致回 null，走初始默认值
      const raw = localStorage.getItem(name)
      if (raw === null) return null
      try {
        const value = jsonStorage!.getItem(name)
        // last-good 随时刷新；备份写失败不影响主流程
        try {
          localStorage.setItem(`${name}.bak`, raw)
        } catch {
          /* 忽略备份失败 */
        }
        return value
      } catch {
        console.warn(`[${tag}] ${name} 内容损坏，现场已另存 .bad-*，尝试从 .bak 恢复`)
        try {
          localStorage.setItem(`${name}.bad-${new Date().toISOString()}`, raw)
        } catch {
          /* 忽略另存失败 */
        }
        const bak = localStorage.getItem(`${name}.bak`)
        if (bak === null) return null
        try {
          return JSON.parse(bak)
        } catch {
          return null
        }
      }
    },
    setItem: (name, value) => {
      jsonStorage!.setItem(name, value)
    },
    removeItem: (name) => {
      jsonStorage!.removeItem(name)
    }
  }
}
