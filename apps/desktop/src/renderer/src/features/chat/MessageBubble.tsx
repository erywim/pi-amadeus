import * as React from 'react'
import { Mic } from 'lucide-react'
import type { Message } from '@pi-amadeus/shared'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { Markdown } from './Markdown'
import { WorkProcessCard } from './WorkProcessCard'

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

interface MessageBubbleProps {
  message: Message
  /** 流式中的临时消息：末尾加闪烁光标 */
  streaming?: boolean
}

/**
 * Codex 风消息：
 * 用户 = 右对齐软卡；助手 = 30px 圆形印记 + 正文列（可含工作过程折叠卡 + markdown）。
 */
export function MessageBubble({ message, streaming = false }: MessageBubbleProps): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="anim-msg flex flex-col items-end gap-1">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-soft px-3.5 py-2.5 text-[15px] leading-relaxed">
          {message.content}
        </div>
        <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
          {message.mode === 'voice' && <Mic className="size-3" />}
          <span>{timeFormatter.format(message.createdAt)}</span>
        </div>
      </div>
    )
  }

  return <AssistantNode message={message} streaming={streaming} />
}

/** 助手节点：工作卡从归档日志取（非流式）；流式本体的卡由 MessageList 提供 */
function AssistantNode({ message, streaming }: MessageBubbleProps): React.JSX.Element {
  const workLog = useSessionStore((s) => s.workLogs[message.id])

  return (
    <div className="anim-msg grid grid-cols-[30px_minmax(0,1fr)] gap-3">
      <div className="grid size-[30px] place-items-center rounded-full border border-line-strong bg-surface">
        <span className="font-mono text-[13px] font-bold text-foreground">K</span>
      </div>
      <div className="flex min-w-0 flex-col gap-2 text-[15px] leading-relaxed">
        {!streaming && workLog && <WorkProcessCard log={workLog} />}
        <div className="break-words">
          <Markdown content={message.content} />
          {streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-primary align-middle" />
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono text-ink-2/80">Amadeus</span>
          {message.mode === 'voice' && <Mic className="size-3" />}
          <span>·</span>
          <span>{timeFormatter.format(message.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}
