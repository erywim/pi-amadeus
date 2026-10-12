import * as React from 'react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '@pi-amadeus/shared'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

const EMPTY_MESSAGES: Message[] = []

/** 用户气泡（语音回合带"语音 · "前缀，原型 voice-tag） */
function UserBubble({ text, isVoice }: { text: string; isVoice?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="anim-msg flex justify-end">
      <div className="max-w-[88%] rounded-xl rounded-br-[4px] bg-primary px-3.5 py-2.5 text-[15px] leading-relaxed text-primary-foreground">
        {isVoice && (
          <span className="mr-1 text-[12.5px] opacity-75">{t('companion.voicePrefix')}</span>
        )}
        <span className="whitespace-pre-wrap break-words">{text}</span>
      </div>
    </div>
  )
}

/** 红莉栖气泡：AMADEUS 署名标签 + 浅色软卡 */
function AssistantBubble({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element {
  return (
    <div className="anim-msg flex flex-col items-start gap-[5px]">
      <span className="amadeus-tag">AMADEUS</span>
      <div className="max-w-[88%] rounded-xl rounded-bl-[4px] border border-border bg-surface-soft px-3.5 py-2.5 text-[15px] leading-relaxed text-foreground">
        <span className="whitespace-pre-wrap break-words">{text}</span>
        {streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-primary align-middle" />
        )}
      </div>
    </div>
  )
}

/** 语音回合中（首字未回）三点打字提示 */
function ThinkingBubble(): React.JSX.Element {
  return (
    <div className="anim-msg flex flex-col items-start gap-[5px]">
      <span className="amadeus-tag">AMADEUS</span>
      <div className="rounded-xl rounded-bl-[4px] border border-border bg-surface-soft px-4 py-3">
        <span className="inline-flex h-[1em] items-center gap-1">
          {[0, 1, 2].map((i) => (
            <i
              key={i}
              className="anim-blink inline-block size-[5px] rounded-full bg-muted-foreground"
              style={{ animationDelay: `${i * 0.18}s` }}
            />
          ))}
        </span>
      </div>
    </div>
  )
}

/**
 * 陪伴模式对话流（右栏）：历史消息 + 语音回合乐观用户气泡 +
 * 进行中回合的实时回复（dialogText 流式拼接）+ 首轮引导问候语。
 */
export function CompanionThread(): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) =>
    s.activeSessionId ? (s.messages[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const pendingUserText = useCompanionStore((s) => s.pendingUserText)
  const setPendingUser = useCompanionStore((s) => s.setPendingUser)
  const dialogText = useUiStore((s) => s.dialogText)
  const voiceActive = useLive2dSpeechStore((s) => s.voiceActive)

  // 服务端消息追到乐观气泡后清除占位
  useEffect(() => {
    if (!pendingUserText) return
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser && lastUser.content.trim() === pendingUserText.trim()) setPendingUser(null)
  }, [messages, pendingUserText, setPendingUser])

  const bottomRef = useRef<HTMLDivElement>(null)
  const draftLength = dialogText.length
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [activeSessionId, messages.length, draftLength, pendingUserText, voiceActive])

  const showGreeting =
    messages.length === 0 && !pendingUserText && !voiceActive && dialogText === ''
  // 语音回合的流式草稿：对话流里显示"净回复"（开头可能短暂挂着"你说：…"前缀时剔除）
  const liveDraft = voiceActive ? dialogText.replace(/^你说：.*?\n?/, '') : ''

  return (
    <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-3 pt-5" aria-live="polite">
      <div className="flex flex-col gap-4">
        {showGreeting && <AssistantBubble text={t('companion.greeting')} />}
        {messages.map((m) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} text={m.content} isVoice={m.mode === 'voice'} />
          ) : (
            <AssistantBubble key={m.id} text={m.content} />
          )
        )}
        {pendingUserText && <UserBubble text={pendingUserText} isVoice />}
        {voiceActive && (liveDraft ? <AssistantBubble text={liveDraft} streaming /> : <ThinkingBubble />)}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
