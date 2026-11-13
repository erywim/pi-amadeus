/**
 * 模型服务故障转移（参考常见的多模型服务 的 provider failover）：
 * 真实回合或连通性测试失败后，把该服务标记为「冷却中」；
 * 冷却期内新的回合按 priority 自动改用下一个健康服务，成功后立即解除。
 *
 * 只在内存里记：大脑重启后所有服务都重新视为健康——
 * 持久化一个可能已经恢复的故障状态，比重新试一次更糟。
 */

/** 冷却时长：10 分钟。期间不会主动再打这个服务，避免每回合都等超时 */
const COOLDOWN_MS = 10 * 60_000

const failedAt = new Map<string, number>()

export function markProviderFailure(providerId: string | undefined): void {
  if (!providerId) return
  failedAt.set(providerId, Date.now())
}

export function markProviderSuccess(providerId: string | undefined): void {
  if (!providerId) return
  failedAt.delete(providerId)
}

export function isProviderCoolingDown(providerId: string): boolean {
  const at = failedAt.get(providerId)
  if (at === undefined) return false
  if (Date.now() - at > COOLDOWN_MS) {
    failedAt.delete(providerId)
    return false
  }
  return true
}

/** 测试用：清空所有冷却状态 */
export function clearProviderFailures(): void {
  failedAt.clear()
}
