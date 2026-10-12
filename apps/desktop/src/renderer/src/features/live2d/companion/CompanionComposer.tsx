import * as React from 'react'
import { useRef, useState } from 'react'
import { ArrowUp, Mic } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { startMic, stopAssistantVoiceTurn, stopMic, startAssistantVoiceTurn } from '@renderer/lib/voice'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/** 快速话题（首轮引导）：label 短词 + 实际发送的完整问题 */
const QUICK_TOPICS = [
  { label: 'companion.topics.who', text: 'companion.topics.whoText' },
  { label: 'companion.topics.research', text: 'companion.topics.researchText' },
  { label: 'companion.topics.ramen', text: 'companion.topics.ramenText' },
  { label: 'companion.topics.worldline', text: 'companion.topics.worldlineText' }
] as const

/**
 * 陪伴模式输入区：快速话题 rail（首轮后收起）+ 麦克风（VAD 自动切段发送）
 * + 自动长高文本框（Enter 发送 / Shift+Enter 换行）。
 * 陪伴模式里无论打字还是说话都走 /api/voice 回合（双语言 + TTS + 口型）。
 */
export function CompanionComposer(): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const userId = useSessionStore((s) => s.userId)
  const textStreaming = useSessionStore((s) => s.stream.streaming)
  const hasMessages = useSessionStore((s) => {
    const list = s.activeSessionId ? s.messages[s.activeSessionId] : undefined
    return (list?.length ?? 0) > 0
  })
  const voiceActive = useLive2dSpeechStore((s) => s.voiceActive)
  const micActive = useUiStore((s) => s.micActive)
  const setMicActive = useUiStore((s) => s.setMicActive)
  const openLogin = useUiStore((s) => s.openLogin)
  const pendingUserText = useCompanionStore((s) => s.pendingUserText)
  const setPendingUser = useCompanionStore((s) => s.setPendingUser)
  const dismissed = useCompanionStore((s) => s.quickTopicsDismissed)
  const dismissTopics = useCompanionStore((s) => s.dismissQuickTopics)

  const busy = voiceActive || textStreaming
  const showTopics = !dismissed && !hasMessages && !pendingUserText

  function send(value: string): void {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    if (!userId) {
      toast.error(t('settings.ai.loginRequired'))
      openLogin()
      return
    }
    dismissTopics()
    setPendingUser(trimmed)
    const started = startAssistantVoiceTurn(trimmed)
    if (!started) {
      setPendingUser(null)
      return
    }
    if (micActive) toggleMic()
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = ''
  }

  function toggleMic(): void {
    if (!userId) {
      toast.error(t('settings.ai.loginRequired'))
      openLogin()
      return
    }
    if (micActive) {
      stopMic()
      // 关麦同时中止进行中的语音回合与 TTS 播放
      stopAssistantVoiceTurn()
      setPendingUser(null)
      setMicActive(false)
    } else {
      startMic()
        .then(() => setMicActive(true))
        .catch(() => setMicActive(false))
    }
  }

  function resize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  return (
    <div className="border-t border-border px-4 pb-4 pt-3">
      {showTopics && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {QUICK_TOPICS.map((topic) => (
            <button
              key={topic.label}
              type="button"
              disabled={busy}
              onClick={() => send(t(topic.text))}
              className="flex-none whitespace-nowrap rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[13.5px] text-ink-2 transition-colors hover:border-primary hover:bg-accent-soft hover:text-primary disabled:opacity-50"
            >
              {t(topic.label)}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-end gap-2 rounded-xl border border-line-strong bg-surface p-2 transition-shadow focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <button
          type="button"
          aria-label={t('companion.micToggle')}
          aria-pressed={micActive}
          onClick={toggleMic}
          className={cn(
            'mic-btn grid size-10 flex-none place-items-center rounded-[10px] border border-border bg-surface text-ink-2 transition-colors hover:bg-surface-soft',
            micActive && 'mic-listening border-primary bg-primary text-accent-ink'
          )}
        >
          <Mic className="size-4" strokeWidth={1.7} />
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          aria-label={t('companion.inputAria')}
          placeholder={micActive ? t('companion.listeningPlaceholder') : t('companion.inputPlaceholder')}
          onChange={(e) => {
            setText(e.target.value)
            resize(e.target)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send(text)
            }
          }}
          className="max-h-[120px] min-h-[40px] min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-[7px] text-[15px] leading-6 outline-none"
        />
        <button
          type="submit"
          aria-label={t('chat.send')}
          disabled={!text.trim() || busy}
          className="grid size-10 flex-none place-items-center rounded-[10px] bg-foreground text-accent-ink transition-[filter,transform] hover:brightness-90 active:scale-[0.94] disabled:bg-line-strong"
        >
          <ArrowUp className="size-4" strokeWidth={2} />
        </button>
      </form>
      <p className="mt-2 min-h-[18px] text-[12.5px] text-muted-foreground">
        {micActive ? t('companion.hintListening') : t('companion.hint')}
      </p>
    </div>
  )
}
