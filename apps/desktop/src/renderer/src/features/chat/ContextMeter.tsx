import * as React from 'react'
import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ResolvedModelRuntime } from '@pi-amadeus/shared'
import { fetchModelRuntime } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { useProviderStore } from '@renderer/stores/providerStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'

/**
 * 粗略 token 估算：中日文字符约 1 token/字，其余按 3.6 字符/token。
 * 只统计当前可见消息与流式草稿，不含系统提示、工具结果与附件正文，
 * 所以界面明确标成「估算」而不是账单读数。
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[㐀-鿿぀-ヿ]/g) ?? []).length
  return Math.ceil(cjk * 1.05 + (text.length - cjk) / 3.6)
}

function formatK(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

/** 输入区上下文读数：已用估算 / 模型窗口，超过 75% 与 90% 时变色提醒 */
export function ContextMeter(): React.JSX.Element | null {
  const { t } = useTranslation()
  const messages = useSessionStore((s) =>
    s.activeSessionId ? s.messages[s.activeSessionId] : undefined
  )
  const draft = useSessionStore((s) =>
    s.stream.sessionId === s.activeSessionId ? (s.stream.draft?.content ?? '') : ''
  )
  const userId = useSessionStore((s) => s.userId)
  const streaming = useSessionStore((s) => s.stream.streaming)
  const providers = useProviderStore((s) => s.providers)
  const configuredProvider = useSettingsStore((s) => s.aiConfig.provider)
  const runtimeKey = JSON.stringify([userId, streaming, providers, configuredProvider])
  const [resolved, setResolved] = React.useState<{ key: string; runtime: ResolvedModelRuntime | null } | null>(null)

  React.useEffect(() => {
    if (!userId) return
    const controller = new AbortController()
    // 配置或回合状态变化后重新解析路由；旧请求中止，避免冷却/切换后的窗口被旧响应覆盖。
    void fetchModelRuntime(userId, controller.signal).then(
      (runtime) => { if (!controller.signal.aborted) setResolved({ key: runtimeKey, runtime }) },
      () => { if (!controller.signal.aborted) setResolved({ key: runtimeKey, runtime: null }) }
    )
    return () => controller.abort()
  }, [userId, runtimeKey])
  const runtime = resolved?.key === runtimeKey ? resolved.runtime : null

  let used = 0
  for (const message of messages ?? []) used += estimateTokens(message.content)
  if (draft) used += estimateTokens(draft)
  if (used === 0 || !runtime) return null

  const { model, contextWindow: limit } = runtime
  const ratio = Math.min(1, used / limit)
  const tone = ratio >= 0.9 ? 'bg-destructive' : ratio >= 0.75 ? 'bg-amber-500' : 'bg-primary'

  return (
    <span
      data-testid="context-meter"
      title={`${t('chatShell.contextHint')}${model ? ` · ${model}` : ''}`}
      className="hidden items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground sm:flex"
    >
      <Gauge className="size-3.5 shrink-0" strokeWidth={1.7} />
      <span className="h-1 w-10 overflow-hidden rounded-full bg-line-strong/70">
        <span
          className={cn('block h-full rounded-full transition-[width] duration-300', tone)}
          style={{ width: `${Math.max(3, ratio * 100)}%` }}
        />
      </span>
      <span className="whitespace-nowrap font-mono text-[10.5px]">
        ≈{formatK(used)} / {formatK(limit)}
      </span>
    </span>
  )
}
