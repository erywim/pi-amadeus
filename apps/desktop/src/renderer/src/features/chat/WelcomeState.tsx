import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DivergenceMeter } from '@renderer/components/effects/DivergenceMeter'
import { GlitchHeading } from '@renderer/components/effects/GlitchHeading'

/** 无选中会话时的欢迎屏：glitch 标题 + 世界线变动率计 */
export function WelcomeState(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-10 px-8">
      <GlitchHeading text={t('app.tagline')} />
      <DivergenceMeter />
      <p className="max-w-md text-center text-sm leading-relaxed text-muted-foreground">{t('chat.welcomeHint')}</p>
    </div>
  )
}
