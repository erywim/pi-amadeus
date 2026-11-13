import * as React from 'react'
import { Brain, Check, ChevronRight, MessageSquare, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { activeProviderOf, useProviderStore } from '@renderer/stores/providerStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { EMPTY_MESSAGES } from './helpers'

type Phase = 'idle' | 'think' | 'tool' | 'reply' | 'done'
type StepState = 'idle' | 'active' | 'done'

/**
 * 本轮阶段管线（工作台顶部那排阶段胶囊）：
 * 状态全部来自真实回合事件——没有工具调用就不会亮「工具」，
 * 流式正文出现才进入「回复」，回合结束才点亮「完成」。
 */
export function StagePipeline(): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) =>
    s.activeSessionId ? (s.messages[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const stream = useSessionStore((s) => s.stream)
  const turnError = useSessionStore((s) =>
    s.activeSessionId ? s.turnErrors[s.activeSessionId] : undefined
  )
  const providers = useProviderStore((s) => s.providers)
  const fallbackModel = useSettingsStore((s) => s.aiConfig.provider.model)
  const model = activeProviderOf(providers)?.model || fallbackModel

  const streaming = stream.streaming && stream.sessionId === activeSessionId
  const draftLength = stream.draft?.content.length ?? 0
  const toolCount = stream.tools.length
  const last = messages.at(-1)

  const phase: Phase = streaming
    ? draftLength > 0
      ? 'reply'
      : toolCount > 0
        ? 'tool'
        : 'think'
    : messages.length > 0
      ? last?.role === 'assistant'
        ? 'done'
        : 'think'
      : 'idle'

  const stateOf = (step: Exclude<Phase, 'idle'>): StepState => {
    if (phase === 'idle') return 'idle'
    if (phase === step) return 'active'
    const order: Exclude<Phase, 'idle'>[] = ['think', 'tool', 'reply', 'done']
    return order.indexOf(phase) > order.indexOf(step) ? 'done' : 'idle'
  }

  const steps = [
    { key: 'think' as const, icon: Brain, label: t('workbench.stage.think') },
    { key: 'tool' as const, icon: Wrench, label: t('workbench.stage.tool') },
    { key: 'reply' as const, icon: MessageSquare, label: t('workbench.stage.reply') },
    { key: 'done' as const, icon: Check, label: t('workbench.stage.done') }
  ]

  return (
    <div
      data-testid="stage-pipeline"
      data-phase={phase}
      className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border bg-surface px-4"
    >
      <div className="flex items-center gap-1 overflow-x-auto">
        {steps.map((step, index) => {
          const state = stateOf(step.key)
          const Icon = step.icon
          return (
            <React.Fragment key={step.key}>
              {index > 0 && (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" strokeWidth={1.8} />
              )}
              <span
                data-testid={`stage-${step.key}`}
                data-state={state}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11.5px] transition-colors',
                  state === 'active' &&
                    'border-primary/35 bg-accent-soft font-medium text-foreground',
                  state === 'done' && 'border-border bg-surface text-muted-foreground',
                  state === 'idle' && 'border-transparent text-muted-foreground/60'
                )}
              >
                {state === 'done' ? (
                  <Check className="size-3 text-mint" strokeWidth={2.4} />
                ) : (
                  <Icon
                    className={cn(
                      'size-3',
                      state === 'active' ? 'text-primary' : 'text-muted-foreground/60'
                    )}
                    strokeWidth={1.9}
                  />
                )}
                <span>{step.label}</span>
                {step.key === 'tool' && toolCount > 0 && (
                  <span className="rounded-full bg-surface-soft px-1 font-mono text-[9.5px] text-ink-2">
                    {toolCount}
                  </span>
                )}
              </span>
            </React.Fragment>
          )
        })}
      </div>

      <span className="flex-1" />

      {turnError && !streaming && (
        <span
          data-testid="stage-error"
          className="inline-flex items-center gap-1 rounded-full border border-destructive/40 px-2 py-[2px] text-[10.5px] text-destructive"
        >
          {t('workbench.stageIdle')}
        </span>
      )}
      {/* 模型名在状态条/服务条里也有；窄窗口（工件面板展开时）优先给阶段让位 */}
      <span className="hidden items-center gap-1.5 2xl:inline-flex">
        <span
          className={cn(
            'size-1.5 rounded-full',
            streaming ? 'anim-blink bg-mint' : 'bg-line-strong'
          )}
        />
        <span
          data-testid="stage-model"
          className="max-w-[180px] truncate font-mono text-[10.5px] text-muted-foreground"
          title={model}
        >
          {model || t('workbench.stageIdle')}
        </span>
      </span>
    </div>
  )
}
