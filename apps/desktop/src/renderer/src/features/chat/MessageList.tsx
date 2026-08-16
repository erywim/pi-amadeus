import * as React from 'react'
import { useEffect, useRef } from 'react'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { BashConfirmCard, ToolActivityCard } from './ToolActivityCard'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

/** 流式内容少于该长度时显示 typing indicator（假 SSE 首字符来得太快，拉长可见性） */
const TYPING_THRESHOLD = 12

export function MessageList(): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) => (s.activeSessionId ? s.messages[s.activeSessionId] : undefined))
  const stream = useSessionStore((s) => s.stream)
  const respondToolConfirm = useSessionStore((s) => s.respondToolConfirm)
  const bottomRef = useRef<HTMLDivElement>(null)

  const list = messages ?? []
  const draftLength = stream.draft?.content.length ?? 0

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [activeSessionId, list.length, draftLength, stream.tools.length, stream.pendingConfirm])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-4">
      <div className="flex flex-col gap-4">
        {list.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {stream.streaming && stream.draft && stream.draft.content.length < TYPING_THRESHOLD && <TypingIndicator />}
        {stream.streaming && stream.draft && stream.draft.content.length >= TYPING_THRESHOLD && (
          <MessageBubble
            streaming
            message={{
              id: stream.draft.messageId,
              sessionId: activeSessionId ?? '',
              role: 'assistant',
              content: stream.draft.content,
              ttsText: null,
              mode: 'text',
              createdAt: Date.now()
            }}
          />
        )}
        {stream.tools.map((item) => (
          <ToolActivityCard key={item.toolCallId} item={item} />
        ))}
        {stream.pendingConfirm && (
          <BashConfirmCard confirm={stream.pendingConfirm} onRespond={respondToolConfirm} />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
