import * as React from 'react'
import { ChevronLeft, ChevronRight, Copy, FileText, Mic, Pencil, RotateCcw } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { Message, MessageAttachment } from '@pi-amadeus/shared'
import { BRAIN_URL } from '@renderer/lib/api'
import { copyText } from '@renderer/lib/clipboard'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { ChangedFilesCard } from './ChangedFilesCard'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
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
 * 紧凑工作台风消息：
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
    return <UserNode message={message} />
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
    <div
      data-message-id={message.id}
      className="group anim-msg flex flex-col items-end gap-1"
    >
      <div className="max-w-[85%] rounded-xl border border-border bg-surface-soft px-3.5 py-2.5 text-[15px] leading-relaxed">
        <MessageAttachments attachments={message.attachments ?? []} />
        {message.content && (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
        {message.mode === 'voice' && <Mic className="size-3" />}
        <span>{timeFormatter.format(message.createdAt)}</span>
        <BranchSwitcher message={message} />
        <MessageActions
          content={message.content}
          showRegenerate={false}
          {...(!streaming ? { onEdit: startEdit } : {})}
        />
      </div>
    </div>
  )
}

/** 分支切换器：同一父节点下的第 n/m 条，左右切换当前活跃分支 */
function BranchSwitcher({ message }: { message: Message }): React.JSX.Element | null {
  const { t } = useTranslation()
  const switchBranch = useSessionStore((s) => s.switchBranch)
  const count = message.branchCount ?? 1
  if (count <= 1) return null
  const index = message.branchIndex ?? 1
  return (
    <span data-testid="branch-switcher" className="inline-flex items-center gap-0.5 text-[11px]">
      <button
        type="button"
        data-testid="branch-prev"
        aria-label={t('chat.branchPrev')}
        title={t('chat.branchPrev')}
        disabled={index <= 1}
        onClick={() =>
          void switchBranch(message.id, -1).catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : String(error))
          )
        }
        className="rounded p-0.5 text-muted-foreground hover:bg-surface-soft hover:text-foreground disabled:opacity-30"
      >
        <ChevronLeft className="size-3" />
      </button>
      <span className="min-w-[24px] text-center font-mono text-[10px] text-muted-foreground">
        {index}/{count}
      </span>
      <button
        type="button"
        data-testid="branch-next"
        aria-label={t('chat.branchNext')}
        title={t('chat.branchNext')}
        disabled={index >= count}
        onClick={() =>
          void switchBranch(message.id, 1).catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : String(error))
          )
        }
        className="rounded p-0.5 text-muted-foreground hover:bg-surface-soft hover:text-foreground disabled:opacity-30"
      >
        <ChevronRight className="size-3" />
      </button>
    </span>
  )
}

/** 消息附件：图片缩略图 / 语音播放器 / 文件下载卡 */
function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }): React.JSX.Element | null {
  if (attachments.length === 0) return null
  const images = attachments.filter((item) => item.kind === 'image' && item.url)
  const audios = attachments.filter((item) => item.kind === 'audio')
  const files = attachments.filter((item) => item.kind === 'file')
  return (
    <div data-testid="message-attachments" className="mb-2 flex flex-col gap-1.5">
      {images.length > 0 && (
        <div className="grid max-w-[420px] grid-cols-2 gap-1.5">
          {images.map((item) => (
            <a
              key={item.id}
              href={mediaUrl(item.url)}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-lg border border-border"
              title={item.name}
            >
              <img
                src={mediaUrl(item.url)}
                alt={item.name}
                className="max-h-[220px] w-full object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {audios.map((item) => (
        <div key={item.id} className="max-w-[420px]">
          <span className="mb-0.5 block truncate text-[11.5px] text-muted-foreground">{item.name}</span>
          <audio controls src={mediaUrl(item.url)} className="w-full" />
        </div>
      ))}
      {files.map((item) => (
        <a
          key={item.id}
          href={mediaUrl(item.url)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-[420px] items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink-2 hover:bg-surface-soft"
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatBytes(item.size)}
          </span>
        </a>
      ))}
    </div>
  )
}

function mediaUrl(url: string): string {
  if (!url || url.startsWith('data:') || /^https?:/i.test(url)) return url
  return `${BRAIN_URL}${url}`
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
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
    <div
      data-message-id={message.id}
      className="group anim-msg grid grid-cols-[30px_minmax(0,1fr)] gap-3"
    >
      <div className="grid size-[30px] place-items-center rounded-full border border-line-strong bg-surface">
        <span className="font-mono text-[13px] font-bold text-foreground">K</span>
      </div>
      <div className="flex min-w-0 flex-col gap-2 text-[15px] leading-relaxed">
        {!streaming && workLog && <WorkProcessCard log={workLog} />}
        {!streaming && (message.changedFiles?.length ?? 0) > 0 && (
          <ChangedFilesCard files={message.changedFiles!} />
        )}
        {message.thinking && <ThinkingBlock content={message.thinking} />}
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
          <BranchSwitcher message={message} />
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
