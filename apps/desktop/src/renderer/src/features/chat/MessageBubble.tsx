import * as React from 'react'
import { Mic } from 'lucide-react'
import type { Message } from '@pi-amadeus/shared'
import { Avatar, AvatarFallback } from '@renderer/components/ui/avatar'
import { Markdown } from './Markdown'

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

interface MessageBubbleProps {
  message: Message
  /** 流式中的临时消息：末尾加闪烁光标 */
  streaming?: boolean
}

/** 单条消息气泡：用户右绿、助手左卡（markdown 渲染） */
export function MessageBubble({ message, streaming = false }: MessageBubbleProps): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1 px-4">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-terminal-green/30 bg-terminal-green/10 px-3.5 py-2.5 text-[13.5px] leading-relaxed">
          {message.content}
        </div>
        <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
          {message.mode === 'voice' && <Mic className="size-3" />}
          <span>{timeFormatter.format(message.createdAt)}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-2.5 px-4">
      <Avatar className="mt-1 size-7 shrink-0 border border-primary/40">
        <AvatarFallback className="bg-primary/10 font-mono text-[11px] font-bold text-primary">K</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 max-w-[75%] flex-col gap-1">
        <div className="rounded-lg rounded-tl-sm border border-border bg-card px-3.5 py-2.5 text-[13.5px] leading-relaxed">
          <Markdown content={message.content} />
          {streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-cyber-cyan align-middle" />
          )}
        </div>
        <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
          <span className="font-mono text-primary/80">Amadeus</span>
          {message.mode === 'voice' && <Mic className="size-3" />}
          <span>·</span>
          <span>{timeFormatter.format(message.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}
