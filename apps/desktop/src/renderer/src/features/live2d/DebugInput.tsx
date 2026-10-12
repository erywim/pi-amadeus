import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { startAssistantVoiceTurn } from '@renderer/lib/voice'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/**
 * 开发者调试输入框：输入中文走完整语音链路（双语言 → TTS → 口型），无需麦克风。
 * 发送期间禁用；收到首个 delta 后清空输入。
 */
export function DebugInput(): React.JSX.Element {
  const { t } = useTranslation()
  const debugText = useUiStore((s) => s.debugText)
  const setDebugText = useUiStore((s) => s.setDebugText)
  const streaming = useSessionStore((s) => s.stream.streaming)
  const userId = useSessionStore((s) => s.userId)

  function send(): void {
    const text = debugText.trim()
    if (!text || !userId) return
    if (startAssistantVoiceTurn(text)) {
      setDebugText('')
    }
  }

  return (
    <div className="absolute right-7 top-[76px] z-30 w-[300px] rounded-md border border-border bg-card/90 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {t('live2d.debug.title')}
        </span>
        <Badge variant="outline" className="border-amber-sg/50 text-[10px] text-amber-sg">
          DEV
        </Badge>
      </div>
      <Textarea
        rows={3}
        value={debugText}
        onChange={(e) => setDebugText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={t('live2d.debug.placeholder')}
        className="mb-2 text-xs"
      />
      <Button size="sm" disabled={streaming || !userId} onClick={send} className="w-full">
        {t('live2d.debug.send')}
      </Button>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{t('live2d.debug.hint')}</p>
    </div>
  )
}
