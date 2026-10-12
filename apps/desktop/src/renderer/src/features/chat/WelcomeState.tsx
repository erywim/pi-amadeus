import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { GlitchHeading } from '@renderer/components/effects/GlitchHeading'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 无选中会话时的欢迎屏：glitch 标题 + 新任务引导 */
export function WelcomeState(): React.JSX.Element {
  const { t } = useTranslation()
  const createSession = useSessionStore((s) => s.createSession)

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
      <GlitchHeading text={t('app.tagline')} />
      <p className="max-w-md text-center text-sm leading-relaxed text-muted-foreground">
        {t('codex.welcomeHint')}
      </p>
      <button
        type="button"
        onClick={() => createSession()}
        className="rounded-[10px] border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-surface-soft"
      >
        {t('codex.newTask')}
      </button>
    </div>
  )
}
