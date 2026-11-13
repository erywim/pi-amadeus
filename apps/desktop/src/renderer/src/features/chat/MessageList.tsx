import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BashConfirmCard } from './BashConfirmCard'
import { ComputerConfirmCard } from './ComputerConfirmCard'
import { MessageBubble } from './MessageBubble'
import { TurnErrorCard } from './TurnErrorCard'
import { WorkProcessCard } from './WorkProcessCard'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 流式内容少于该长度且尚无工具活动时显示 typing dots（假 SSE 首字符来得太快，拉长可见性） */
const TYPING_THRESHOLD = 12
/** 距底部小于该距离视为「正在看最新内容」，超过则暂停自动跟随 */
const BOTTOM_GAP = 80

export function MessageList(): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) => (s.activeSessionId ? s.messages[s.activeSessionId] : undefined))
  const stream = useSessionStore((s) => s.stream)
  const stoppedLog = useSessionStore((s) =>
    s.activeSessionId ? s.stoppedLogs[s.activeSessionId] : undefined
  )
  const turnError = useSessionStore((s) =>
    s.activeSessionId ? s.turnErrors[s.activeSessionId] : undefined
  )
  const respondToolConfirm = useSessionStore((s) => s.respondToolConfirm)
  const respondComputer = useSessionStore((s) => s.respondComputer)
  const regenerate = useSessionStore((s) => s.regenerate)
  const dismissTurnError = useSessionStore((s) => s.dismissTurnError)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  /** 上一条消息 id：用于识别「刚刚发出用户消息」这个需要强制跟到底部的动作 */
  const prevLastKeyRef = useRef<string | null>(null)
  /** 程序触发的平滑滚动进行中：期间忽略「离开底部」的判定，避免按钮滚动途中又弹回来 */
  const jumpGuardRef = useRef(false)

  const list = messages ?? []
  const lastMessage = list.at(-1)
  const lastMessageKey = lastMessage?.id ?? null
  const draftLength = stream.draft?.content.length ?? 0
  // 流式区块只展示给产生它的会话：流全局唯一，切会话后不串台渲染
  const streamInView = stream.sessionId != null && stream.sessionId === activeSessionId
  const showTyping =
    stream.streaming && stream.tools.length === 0 && draftLength < TYPING_THRESHOLD
  const showDraftBubble =
    stream.streaming && stream.draft && (stream.tools.length > 0 || draftLength >= TYPING_THRESHOLD)
  // 最后一条助手消息挂「重新生成」入口（末尾是用户消息时由错误卡/重试承担）
  const lastAssistantId = [...list].reverse().find((m) => m.role === 'assistant')?.id

  // 切换会话：直接落到该会话最新内容，并恢复自动跟随
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
    prevLastKeyRef.current = null
  }, [activeSessionId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 刚发出自己的消息：无论此前滚到哪里都跟到底部（发送意图就是看回复）
    const sentByMe = lastMessage?.role === 'user' && lastMessageKey !== prevLastKeyRef.current
    prevLastKeyRef.current = lastMessageKey
    if (sentByMe) setAtBottom(true)
    if (atBottom || sentByMe) {
      bottomRef.current?.scrollIntoView({ behavior: sentByMe ? 'auto' : 'smooth', block: 'end' })
    }
  }, [
    activeSessionId,
    list.length,
    draftLength,
    stream.tools.length,
    stream.pendingConfirm,
    atBottom,
    lastMessage?.role,
    lastMessageKey
  ])

  function handleScroll(): void {
    const el = scrollRef.current
    if (!el) return
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_GAP
    // 程序触发的平滑滚动途中会经过「离底部很远」的中间位置：
    // 此时不能把 atBottom 判回 false，否则「回到底部」按钮会在滚动中重新弹出
    if (jumpGuardRef.current && !next) return
    // 用户上滚阅读历史时暂停自动跟随：新 delta 不该把视线拽回底部；
    // 回到底部附近后自动恢复
    setAtBottom((prev) => (prev === next ? prev : next))
  }

  function jumpToBottom(): void {
    jumpGuardRef.current = true
    setAtBottom(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    // 平滑滚动通常 300-500ms 结束；留一点余量后恢复滚动判定
    window.setTimeout(() => {
      jumpGuardRef.current = false
    }, 600)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="message-scroll"
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain px-5 pb-3 pt-5"
      >
        <div className="mx-auto flex max-w-[780px] flex-col gap-5">
          {list.length === 0 && !stream.streaming && (
            <p className="py-12 text-center text-[13.5px] text-muted-foreground">
              {t('codex.emptyHint')}
            </p>
          )}
          {list.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              isLastAssistant={m.id === lastAssistantId}
              onRegenerate={regenerate}
            />
          ))}

          {/* 当前回合的流式智能体区块：工作过程卡先行露出，随后流出正文 */}
          {stream.streaming && streamInView && (showTyping || showDraftBubble) && (
            <div className="anim-msg grid grid-cols-[30px_minmax(0,1fr)] gap-3">
              <div className="grid size-[30px] place-items-center rounded-full border border-line-strong bg-surface">
                <span className="font-mono text-[13px] font-bold">K</span>
              </div>
              <div className="flex min-w-0 flex-col gap-2 text-[15px] leading-relaxed">
                {stream.tools.length > 0 && <WorkProcessCard live={{ tools: stream.tools }} />}
                {showTyping && (
                  <span className="inline-flex h-[1em] items-center gap-1">
                    {[0, 1, 2].map((i) => (
                      <i
                        key={i}
                        className="anim-blink inline-block size-[5px] rounded-full bg-muted-foreground"
                        style={{ animationDelay: `${i * 0.18}s` }}
                      />
                    ))}
                  </span>
                )}
                {showDraftBubble && stream.draft && (
                  <div className="break-words">
                    <span className="whitespace-pre-wrap">{stream.draft.content}</span>
                    <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-primary align-middle" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 上轮手动停止的残留工作卡 */}
          {!(stream.streaming && streamInView) && stoppedLog && <WorkProcessCard log={stoppedLog} />}

          {/* 回合失败：错误信息与重试入口留在会话里，不只打 console */}
          {turnError && !stream.streaming && (
            <TurnErrorCard
              message={turnError}
              onRetry={regenerate}
              onDismiss={() => {
                if (activeSessionId) dismissTurnError(activeSessionId)
              }}
            />
          )}

          {streamInView && stream.pendingConfirm && (
            <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-3">
              <div className="size-[30px]" aria-hidden />
              <BashConfirmCard confirm={stream.pendingConfirm} onRespond={respondToolConfirm} />
            </div>
          )}
          {streamInView && stream.pendingComputer && (
            <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-3">
              <div className="size-[30px]" aria-hidden />
              <ComputerConfirmCard request={stream.pendingComputer} onRespond={respondComputer} />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 用户上滚后仍能一键回到最新内容 */}
      {!atBottom && (
        <button
          type="button"
          data-testid="scroll-to-bottom"
          onClick={jumpToBottom}
          className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 shadow-[var(--shadow-pop)] transition-colors hover:bg-surface-soft"
        >
          <ArrowDown className="size-3.5" strokeWidth={2} />
          {t('chat.scrollToBottom')}
        </button>
      )}
    </div>
  )
}
