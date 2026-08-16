import * as React from 'react'
import { useTranslation } from 'react-i18next'

/** 流式回复前几帧的 typing indicator（与助手气泡左侧对齐） */
export function TypingIndicator(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5 px-4 pl-[54px]">
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-2.5">
        <span className="size-1.5 animate-bounce rounded-full bg-cyber-cyan" />
        <span className="size-1.5 animate-bounce rounded-full bg-cyber-cyan [animation-delay:140ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-cyber-cyan [animation-delay:280ms]" />
      </div>
      <span className="text-[11px] text-muted-foreground">{t('chat.typing')}</span>
    </div>
  )
}
