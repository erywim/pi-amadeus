import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@renderer/stores/uiStore'

/** 底部对话框：M1 静态占位（dialogText 为空显示占位符），语音链路接入后显示转写 */
export function DialogBox(): React.JSX.Element {
  const { t } = useTranslation()
  const dialogText = useUiStore((s) => s.dialogText)

  return (
    <div className="absolute bottom-5 left-1/2 z-30 w-[min(560px,calc(100%-400px))] -translate-x-1/2">
      <div className="rounded-md border border-primary/25 bg-black/60 px-4 py-2.5 backdrop-blur-sm">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.3em] text-primary/70">
          <span className="size-1.5 animate-pulse rounded-full bg-cyber-cyan" />
          Amadeus
        </div>
        <p className="min-h-[20px] text-sm leading-relaxed text-foreground/90">
          {dialogText || <span className="text-muted-foreground">{t('live2d.dialogPlaceholder')}</span>}
        </p>
      </div>
    </div>
  )
}
