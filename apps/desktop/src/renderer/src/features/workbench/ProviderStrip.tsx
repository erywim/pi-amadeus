import * as React from 'react'
import { AlertTriangle, Check, Plus } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { cn } from '@renderer/lib/utils'
import { activeProviderOf, useProviderStore } from '@renderer/stores/providerStore'
import { laneColorFor } from './helpers'

/**
 * 工作台顶部的模型服务条（Lancer 的 provider chips）：
 * 每个 chip 是真实的服务记录，点击即激活（写入数据库），
 * 冷却中的服务带警告标记；没有服务时引导去设置页连接。
 */
export function ProviderStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const providers = useProviderStore((s) => s.providers)
  const activate = useProviderStore((s) => s.activate)
  const active = activeProviderOf(providers)

  async function handleActivate(id: string): Promise<void> {
    try {
      await activate(id)
      toast.success(t('settings.providers.activated'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <header
      data-testid="provider-strip"
      className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border bg-surface px-4"
    >
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {t('workbench.providerLabel')}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {providers.map((provider) => {
          const isActive = provider.active && provider.enabled
          return (
            <button
              key={provider.id}
              type="button"
              data-testid="provider-chip"
              data-provider-id={provider.id}
              data-active={isActive ? 'true' : 'false'}
              title={`${provider.name} · ${provider.model} — ${t('workbench.providerHint')}`}
              onClick={() => void handleActivate(provider.id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11.5px] transition-colors',
                isActive
                  ? 'border-primary/40 bg-accent-soft font-medium text-foreground'
                  : 'border-border bg-surface text-muted-foreground hover:bg-surface-soft hover:text-foreground',
                !provider.enabled && 'opacity-50'
              )}
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: laneColorFor(provider.id) }}
              />
              <span className="max-w-[120px] truncate">{provider.name}</span>
              <span className="hidden max-w-[130px] truncate font-mono text-[10px] text-muted-foreground md:inline">
                {provider.model}
              </span>
              {provider.coolingDown && (
                <AlertTriangle className="size-3 shrink-0 text-destructive" strokeWidth={2} />
              )}
              {isActive && <Check className="size-3 shrink-0 text-primary" strokeWidth={2.4} />}
            </button>
          )
        })}
        {providers.length === 0 && (
          <span data-testid="provider-empty" className="truncate text-[11.5px] text-muted-foreground">
            {t('workbench.providerEmpty')}
          </span>
        )}
      </div>
      <button
        type="button"
        data-testid="provider-connect"
        onClick={() => navigate('/settings')}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-[3px] text-[11px] text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
      >
        <Plus className="size-3" />
        {t('workbench.providerSettings')}
      </button>
      {active && <span className="sr-only">{active.name}</span>}
    </header>
  )
}
