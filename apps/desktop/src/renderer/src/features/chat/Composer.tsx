import * as React from 'react'
import { useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 消息输入框：Enter 发送 / Shift+Enter 换行，流式中切换为停止按钮 */
export function Composer(): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const streaming = useSessionStore((s) => s.stream.streaming)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)

  function submit(): void {
    const value = text.trim()
    if (!value || streaming) return
    sendMessage(value)
    setText('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // isComposing：中文输入法选词回车不算发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="shrink-0 border-t border-border p-4">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('chat.inputPlaceholder')}
          rows={1}
          className="max-h-40 min-h-[44px] flex-1 resize-none"
        />
        {streaming ? (
          <Button variant="destructive" size="icon" className="size-11 shrink-0" title={t('chat.stop')} onClick={stopStreaming}>
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button size="icon" className="size-11 shrink-0" title={t('chat.send')} disabled={!text.trim()} onClick={submit}>
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  )
}
