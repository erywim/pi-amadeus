import * as React from 'react'
import { Copy, Mic, Pencil, RotateCcw } from 'lucide-react'
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
  onRegenerate?: () => void
}

/**
 * 消息级操作：复制正文；最后一条助手回复额外给「重新生成」。
 * 按钮默认隐藏，悬停或键盘聚焦时出现（与常见助手一致，不打断阅读）。
 */
function MessageActions({
  content,
  showRegenerate,
  onRegenerate,
  onEdit
}: {
  content: string
  showRegenerate: boolean
  onRegenerate?: () => void
  onEdit?: () => void
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
      {onEdit && (
        <button
          type="button"
          data-testid="edit-message"
          onClick={onEdit}
          title={t('chat.edit')}
          aria-label={t('chat.edit')}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
        >
          <Pencil className="size-3" />
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
  onRegenerate
}: MessageBubbleProps): React.JSX.Element {
  if (message.role === 'user') {
    return <UserNode message={message} />
  }

  return (
    <AssistantNode
      message={message}
      streaming={streaming}
      isLastAssistant={isLastAssistant}
      onRegenerate={onRegenerate}
    />
  )
}

/**
 * 用户消息：复制 + 编辑后重发。
 * 编辑会丢弃这条消息之后的对话（服务端同一套截断语义），所以保存前把后果写在输入框下面。
 */
function UserNode({ message }: { message: Message }): React.JSX.Element {
  const { t } = useTranslation()
  const streaming = useSessionStore((s) => s.stream.streaming)
  const editMessage = useSessionStore((s) => s.editMessage)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(message.content)

  function startEdit(): void {
    setDraft(message.content)
    setEditing(true)
  }

  function save(): void {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === message.content) {
      setEditing(false)
      return
    }
    editMessage(message.id, trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="anim-msg flex flex-col items-end gap-1.5">
        <div className="w-full max-w-[85%] rounded-xl border border-primary/50 bg-surface px-3 py-2">
          <textarea
            data-testid="edit-message-input"
            value={draft}
            autoFocus
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-full resize-y bg-transparent text-[15px] leading-relaxed outline-none"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              {t('chat.editHint')}
            </span>
            <span className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-surface-soft hover:text-foreground"
              >
                {t('chat.editCancel')}
              </button>
              <button
                type="button"
                data-testid="edit-message-save"
                disabled={!draft.trim() || streaming}
                onClick={save}
                className="rounded-md bg-primary px-2 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {t('chat.editSave')}
              </button>
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group anim-msg flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-soft px-3.5 py-2.5 text-[15px] leading-relaxed">
        {message.content}
      </div>
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
        {message.mode === 'voice' && <Mic className="size-3" />}
        <span>{timeFormatter.format(message.createdAt)}</span>
        <MessageActions
          content={message.content}
          showRegenerate={false}
          {...(!streaming ? { onEdit: startEdit } : {})}
        />
      </div>
    </div>
  )
}

/** 助手节点：工作卡从归档日志取（非流式）；流式本体的卡由 MessageList 提供 */
function AssistantNode({
  message,
  streaming = false,
  isLastAssistant = false,
  onRegenerate
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
          <MessageActions
            content={message.content}
            showRegenerate={isLastAssistant && !streaming}
            onRegenerate={onRegenerate}
          />
        </div>
      </div>
    </div>
  )
}
