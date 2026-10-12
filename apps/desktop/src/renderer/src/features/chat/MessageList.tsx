import * as React from 'react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BashConfirmCard } from './BashConfirmCard'
import { MessageBubble } from './MessageBubble'
import { WorkProcessCard } from './WorkProcessCard'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 流式内容少于该长度且尚无工具活动时显示 typing dots（假 SSE 首字符来得太快，拉长可见性） */
const TYPING_THRESHOLD = 12

export function MessageList(): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) => (s.activeSessionId ? s.messages[s.activeSessionId] : undefined))
  const stream = useSessionStore((s) => s.stream)
  const stoppedLog = useSessionStore((s) =>
    s.activeSessionId ? s.stoppedLogs[s.activeSessionId] : undefined
  )
  const respondToolConfirm = useSessionStore((s) => s.respondToolConfirm)
  const bottomRef = useRef<HTMLDivElement>(null)

  const list = messages ?? []
  const draftLength = stream.draft?.content.length ?? 0
  // 流式区块只展示给产生它的会话：流全局唯一，切会话后不串台渲染
  const streamInView = stream.sessionId != null && stream.sessionId === activeSessionId
  const showTyping =
    stream.streaming && stream.tools.length === 0 && draftLength < TYPING_THRESHOLD
  const showDraftBubble =
    stream.streaming && stream.draft && (stream.tools.length > 0 || draftLength >= TYPING_THRESHOLD)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [activeSessionId, list.length, draftLength, stream.tools.length, stream.pendingConfirm])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-3 pt-5">
      <div className="mx-auto flex max-w-[780px] flex-col gap-5">
        {list.length === 0 && !stream.streaming && (
          <p className="py-12 text-center text-[13.5px] text-muted-foreground">
            {t('codex.emptyHint')}
          </p>
        )}
        {list.map((m) => (
          <MessageBubble key={m.id} message={m} />
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

        {streamInView && stream.pendingConfirm && (
          <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-3">
            <div className="size-[30px]" aria-hidden />
            <BashConfirmCard confirm={stream.pendingConfirm} onRespond={respondToolConfirm} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
