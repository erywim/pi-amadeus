import * as React from 'react'
import { ChevronLeft, ChevronRight, Copy, CornerUpLeft, Mic, RotateCcw } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { Message } from '@pi-amadeus/shared'
import { copyText } from '@renderer/lib/clipboard'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { Markdown } from './Markdown'
import { WorkProcessCard } from './WorkProcessCard'

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

interface MessageBubbleProps {
  message: Message
  /** 流式中的临时消息：末尾加闪烁光标 */
  streaming?: boolean
  /** 最后一条助手消息：提供「重新生成」入口 */
  isLastAssistant?: boolean
  /** 当前世界线末端：它自己不需要「回退到此处」 */
  isHead?: boolean
  onRegenerate?: () => void
  /** 世界线分叉箭头：在同一条消息的多个版本之间跳跃 */
  onSwitchSibling?: (direction: -1 | 1) => void
  /** 回退到这条消息（世界线分叉点） */
  onRewind?: () => void
}

/**
 * 世界线分叉指示：同一条消息有多个版本时显示 `‹ 2/3 ›`。
 * 这是世界线的分叉点——左右切换等于跳到另一条世界线的同一位置。
 */
function BranchSwitcher({
  siblings,
  currentId,
  onSwitch
}: {
  siblings: string[]
  currentId: string
  onSwitch?: (direction: -1 | 1) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const index = siblings.indexOf(currentId)
  if (!onSwitch || siblings.length < 2 || index < 0) return null
  return (
    <span
      title={t('worldline.switchHint')}
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface px-1 font-mono text-[10.5px] text-ink-2"
    >
      <button
        type="button"
        data-testid="branch-prev"
        disabled={index === 0}
        aria-label={t('worldline.prev')}
        onClick={() => onSwitch(-1)}
        className="rounded p-0.5 transition-colors hover:bg-surface-soft disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronLeft className="size-3" />
      </button>
      <span className="px-0.5" data-testid="branch-index">
        {index + 1}/{siblings.length}
      </span>
      <button
        type="button"
        data-testid="branch-next"
        disabled={index === siblings.length - 1}
        aria-label={t('worldline.next')}
        onClick={() => onSwitch(1)}
        className="rounded p-0.5 transition-colors hover:bg-surface-soft disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronRight className="size-3" />
      </button>
    </span>
  )
}

/**
 * 消息级操作：复制正文；最后一条助手回复额外给「重新生成」；
 * 不在世界线末端的消息额外给「回到这里」（回退后发消息 = 分叉出新世界线）。
 * 按钮默认隐藏，悬停或键盘聚焦时出现（与常见助手一致，不打断阅读）。
 */
function MessageActions({
  content,
  showRegenerate,
  onRegenerate,
  showRewind,
  onRewind
}: {
  content: string
  showRegenerate: boolean
  onRegenerate?: () => void
  showRewind: boolean
  onRewind?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  async function handleCopy(): Promise<void> {
    try {
      await copyText(content)
      setCopied(true)
      toast.success(t('chat.copied'))
      // 复制反馈 1.5s 后复位，避免按钮一直停在「已复制」
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('chat.copyFailed'))
    }
  }

  return (
    <span className="inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        data-testid="copy-message"
        onClick={() => void handleCopy()}
        title={copied ? t('chat.copied') : t('chat.copy')}
        aria-label={t('chat.copy')}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
      >
        <Copy className={cn('size-3', copied && 'text-mint')} />
      </button>
      {showRewind && onRewind && (
        <button
          type="button"
          data-testid="rewind"
          onClick={onRewind}
          title={t('worldline.rewindHint')}
          aria-label={t('worldline.rewind')}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-soft hover:text-primary"
        >
          <CornerUpLeft className="size-3" />
        </button>
      )}
      {showRegenerate && onRegenerate && (
        <button
          type="button"
          data-testid="regenerate"
          onClick={onRegenerate}
          title={t('chat.regenerate')}
          aria-label={t('chat.regenerate')}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
        >
          <RotateCcw className="size-3" />
        </button>
      )}
    </span>
  )
}

/**
 * Codex 风消息：
 * 用户 = 右对齐软卡；助手 = 30px 圆形印记 + 正文列（可含工作过程折叠卡 + markdown）。
 */
export function MessageBubble({
  message,
  streaming = false,
  isLastAssistant = false,
  isHead = false,
  onRegenerate,
  onSwitchSibling,
  onRewind
}: MessageBubbleProps): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="group anim-msg flex flex-col items-end gap-1">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-soft px-3.5 py-2.5 text-[15px] leading-relaxed">
          {message.content}
        </div>
        <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
          <BranchSwitcher
            siblings={message.siblingIds ?? []}
            currentId={message.id}
            onSwitch={onSwitchSibling}
          />
          {message.mode === 'voice' && <Mic className="size-3" />}
          <span>{timeFormatter.format(message.createdAt)}</span>
          <MessageActions
            content={message.content}
            showRegenerate={false}
            showRewind={!isHead}
            onRewind={onRewind}
          />
        </div>
      </div>
    )
  }

  return (
    <AssistantNode
      message={message}
      streaming={streaming}
      isLastAssistant={isLastAssistant}
      isHead={isHead}
      onRegenerate={onRegenerate}
      onSwitchSibling={onSwitchSibling}
      onRewind={onRewind}
    />
  )
}

/** 助手节点：工作卡从归档日志取（非流式）；流式本体的卡由 MessageList 提供 */
function AssistantNode({
  message,
  streaming = false,
  isLastAssistant = false,
  isHead = false,
  onRegenerate,
  onSwitchSibling,
  onRewind
}: MessageBubbleProps): React.JSX.Element {
  const workLog = useSessionStore((s) => s.workLogs[message.id])

  return (
    <div className="group anim-msg grid grid-cols-[30px_minmax(0,1fr)] gap-3">
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
          <BranchSwitcher
            siblings={message.siblingIds ?? []}
            currentId={message.id}
            onSwitch={onSwitchSibling}
          />
          <MessageActions
            content={message.content}
            showRegenerate={isLastAssistant && !streaming}
            onRegenerate={onRegenerate}
            showRewind={!isHead && !streaming}
            onRewind={onRewind}
          />
        </div>
      </div>
    </div>
  )
}
