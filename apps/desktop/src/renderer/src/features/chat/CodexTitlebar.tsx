import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { PanelLeft, Pencil, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'

/** 文本模式的标题栏：侧栏开关 + 标题（可重命名） + 渠道徽标 + 轮次统计 + 删除 */
export function CodexTitlebar({
  sidebarOpen,
  onToggleSidebar
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const messageCount = useSessionStore((s) => {
    const loaded = s.activeSessionId ? s.messages[s.activeSessionId] : undefined
    return loaded?.length ?? s.sessions.find((x) => x.id === s.activeSessionId)?.messageCount ?? 0
  })
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const renameSession = useSessionStore((s) => s.renameSession)
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  /** Esc 取消后紧跟的 blur 不该再提交一次（取消是明确意图） */
  const cancelledRef = useRef(false)

  // 切换会话时退出编辑态：否则输入框里的旧标题会被写到新会话上
  useEffect(() => {
    setEditing(false)
  }, [session?.id])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  function startEditing(): void {
    if (!session) return
    cancelledRef.current = false
    setTitleDraft(session.title)
    setEditing(true)
  }

  function cancelEditing(): void {
    cancelledRef.current = true
    setEditing(false)
    setTitleDraft('')
  }

  async function commitTitle(): Promise<void> {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    if (!session) return
    const next = titleDraft.trim()
    setEditing(false)
    if (!next || next === session.title) return
    try {
      await renameSession(session.id, next)
      toast.success(t('chat.renamed'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  if (!session) {
    return <div className="h-[52px] shrink-0 border-b border-border" />
  }

  const turns = Math.ceil(messageCount / 2)

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
      <button
        type="button"
        aria-label={t('codex.sidebarToggle')}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
        className="grid size-9.5 place-items-center rounded-[10px] border border-border bg-surface text-ink-2 transition-colors hover:bg-surface-soft"
      >
        <PanelLeft className="size-4" strokeWidth={1.8} />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          data-testid="rename-input"
          autoFocus
          value={titleDraft}
          maxLength={80}
          aria-label={t('chat.rename')}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              // 统一走 blur → commit：避免 Enter 与 blur 各提交一次
              inputRef.current?.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelEditing()
            }
          }}
          className="min-w-0 max-w-[420px] flex-1 rounded-md border border-primary bg-surface px-2 py-1 text-[15px] font-semibold outline-none"
        />
      ) : (
        <>
          <h2
            onDoubleClick={startEditing}
            title={t('chat.renameHint')}
            className="min-w-0 truncate text-[15px] font-semibold"
          >
            {session.title || t('codex.untitledTask')}
          </h2>
          <button
            type="button"
            data-testid="rename-session"
            onClick={startEditing}
            aria-label={t('chat.rename')}
            title={t('chat.rename')}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </button>
        </>
      )}
      <Badge
        variant="outline"
        className={cn(
          'gap-1.5 border',
          session.channel === 'feishu'
            ? 'border-feishu-blue/50 text-feishu-blue'
            : 'border-border text-muted-foreground'
        )}
      >
        {t(`channels.${session.channel}`)}
      </Badge>
      <span className="flex-1" />
      <span className="whitespace-nowrap text-[12.5px] text-muted-foreground">
        {t('codex.turns', { count: turns })}
      </span>
      <button
        type="button"
        title={t('chat.deleteTitle')}
        onClick={() => {
          deleteSession(session.id)
          toast.success(t('common.deleted'))
        }}
        className="grid size-9.5 place-items-center rounded-[10px] border border-border bg-surface text-ink-2 transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-4" strokeWidth={1.6} />
      </button>
    </header>
  )
}
