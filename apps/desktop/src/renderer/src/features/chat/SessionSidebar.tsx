import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { DAY_GROUP_ORDER, dayGroupOf, type MessageSearchHit, type Session } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { searchMessagesApi } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { useDivergenceStore } from '@renderer/stores/divergenceStore'
import { useMemoryStore } from '@renderer/stores/memoryStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/** 会话状态点：当前流式进行中 → 琥珀脉冲；已完成 → 薄荷绿 */
function SessionStatusDot({ running }: { running: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-[7px] flex-none rounded-full',
        running ? 'anim-blink bg-primary' : 'bg-mint'
      )}
    />
  )
}

function SessionItem({
  session,
  active,
  running,
  onSelect,
  onDelete,
  onTogglePin
}: {
  session: Session
  active: boolean
  running: boolean
  onSelect: () => void
  onDelete: () => void
  onTogglePin: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const turns = Math.ceil((session.messageCount ?? 0) / 2)

  return (
    <div
      onClick={onSelect}
      data-session-id={session.id}
      className={cn(
        'group w-full cursor-pointer rounded-[10px] px-3 py-2.5 text-ink-2 transition-colors',
        active ? 'bg-surface shadow-[inset_0_0_0_1px_var(--border)]' : 'hover:bg-surface-soft'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SessionStatusDot running={running && active} />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-medium">
          {session.title || t('chatShell.untitledTask')}
        </span>
        <button
          type="button"
          data-testid="session-pin"
          title={session.pinned ? t('chat.unpin') : t('chat.pin')}
          aria-label={session.pinned ? t('chat.unpin') : t('chat.pin')}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          className={cn(
            'shrink-0 rounded p-0.5 transition-colors hover:text-primary',
            session.pinned
              ? 'text-primary'
              : 'hidden text-muted-foreground group-hover:inline-flex'
          )}
        >
          {session.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        </button>
        <Badge
          variant="outline"
          className={cn(
            'shrink-0 border px-1.5 py-0 text-[10px]',
            session.channel === 'feishu'
              ? 'border-feishu-blue/50 text-feishu-blue'
              : 'border-border text-muted-foreground'
          )}
        >
          {t(`channels.${session.channel}`)}
        </Badge>
        <button
          type="button"
          title={t('chat.deleteTitle')}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:inline-flex"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="overflow-hidden text-ellipsis whitespace-nowrap pl-[15px] text-[12.5px] text-muted-foreground">
        {t('chatShell.agentSub', {
          status: running && active ? t('chatShell.stateRunning') : t('chatShell.stateDone'),
          turns
        })}
      </div>
    </div>
  )
}

/**
 * 紧凑工作台风会话侧栏：新任务按钮 / 按天分组的会话列表（状态点 + 轮次副标题） /
 * 底部用户卡（头像、名、研究所头衔、当前世界线读数）。
 */
export function SessionSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const userId = useSessionStore((s) => s.userId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSession = useSessionStore((s) => s.createSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const togglePin = useSessionStore((s) => s.togglePin)
  const streaming = useSessionStore((s) => s.stream.streaming)
  // 流全局只有一条：运行中指示按 stream.sessionId 归属，后台回合不串到别的会话行
  const streamSessionId = useSessionStore((s) => s.stream.sessionId)
  const username = useUiStore((s) => s.username)
  const worldLine = useDivergenceStore((s) => s.value)
  const affinity = useMemoryStore((s) => s.affinity)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MessageSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Cmd/Ctrl+K 聚焦会话搜索（常见助手的全局搜索习惯键位）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 标题过滤在本地做；正文搜索交给服务端一次 LIKE 查询（350ms 防抖）
  const normalizedQuery = query.trim().toLowerCase()
  const visibleSessions = normalizedQuery
    ? sessions.filter((s) => (s.title || '').toLowerCase().includes(normalizedQuery))
    : sessions

  useEffect(() => {
    const trimmed = query.trim()
    if (!userId || !trimmed) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      searchMessagesApi(userId, trimmed)
        .then((result) => setHits(result))
        .catch((error) => console.warn('[session] 消息搜索失败：', error))
        .finally(() => setSearching(false))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [query, userId])

  const pinnedSessions = visibleSessions.filter((s) => s.pinned)
  const groups = DAY_GROUP_ORDER.map((group) => ({
    group,
    sessions: visibleSessions
      .filter((s) => !s.pinned && dayGroupOf(s.updatedAt) === group)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })).filter((g) => g.sessions.length > 0)

  function handleDelete(id: string): void {
    deleteSession(id)
    toast.success(t('common.deleted'))
  }

  return (
    <aside className="grid w-[268px] shrink-0 grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] border-r border-border bg-background">
      <div className="px-4 pb-2 pt-4">
        <button
          type="button"
          onClick={() => createSession()}
          className="flex w-full items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 py-[9px] text-[15px] font-semibold text-foreground transition-colors hover:bg-surface-soft"
        >
          <Plus className="size-4 text-muted-foreground" strokeWidth={2} />
          {t('chatShell.newTask')}
        </button>
      </div>
      <div className="px-4 pb-1 pt-1">
        <div className="flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 transition-colors focus-within:border-primary">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            data-testid="session-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder={t('chat.searchSessions')}
            aria-label={t('chat.searchSessions')}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('chat.clearSearch')}
              title={t('chat.clearSearch')}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>
      <div className="px-4 pb-1 pt-3 text-[12.5px] tracking-[0.04em] text-muted-foreground">
        {t('chatShell.sessionsLabel')}
      </div>
      <div className="flex min-h-0 flex-col gap-px overflow-y-auto px-2 py-1">
        {pinnedSessions.length > 0 && (
          <section className="mb-2">
            <h3 className="mb-1 flex items-center gap-1 px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              <Pin className="size-2.5" />
              {t('chat.pinned')}
            </h3>
            <div className="space-y-0.5">
              {pinnedSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  running={streaming && session.id === streamSessionId}
                  onSelect={() => selectSession(session.id)}
                  onDelete={() => handleDelete(session.id)}
                  onTogglePin={() => {
                    void togglePin(session.id).catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error))
                    )
                  }}
                />
              ))}
            </div>
          </section>
        )}
        {groups.map(({ group, sessions: groupSessions }) => (
          <section key={group} className="mb-2">
            <h3 className="mb-1 px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              {t(`dayGroups.${group}`)}
            </h3>
            <div className="space-y-0.5">
              {groupSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  running={streaming && session.id === streamSessionId}
                  onSelect={() => selectSession(session.id)}
                  onDelete={() => handleDelete(session.id)}
                  onTogglePin={() => {
                    void togglePin(session.id).catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error))
                    )
                  }}
                />
              ))}
            </div>
          </section>
        ))}

        {/* 正文命中：标题没匹配上，但消息内容里有 */}
        {normalizedQuery && (
          <section className="mb-2" data-testid="message-search-results">
            <h3 className="mb-1 flex items-center gap-1 px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              <MessageSquare className="size-2.5" />
              {t('chat.messageResults')} {searching ? '…' : hits.length}
            </h3>
            <div className="space-y-0.5">
              {hits.map((hit) => (
                <button
                  key={hit.messageId}
                  type="button"
                  data-testid="message-hit"
                  onClick={() => selectSession(hit.sessionId)}
                  className="w-full rounded-[10px] px-3 py-2 text-left text-ink-2 transition-colors hover:bg-surface-soft"
                >
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                    <span className="truncate">
                      {hit.sessionTitle || t('chatShell.untitledTask')}
                    </span>
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[9.5px]">
                      {hit.role === 'user' ? 'U' : 'A'}
                    </Badge>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-relaxed text-muted-foreground">
                    {hit.snippet}
                  </span>
                </button>
              ))}
              {!searching && hits.length === 0 && (
                <p className="px-3 py-2 text-[11.5px] text-muted-foreground">
                  {t('chat.noMessageResults')}
                </p>
              )}
            </div>
          </section>
        )}
        {sessions.length === 0 && (
          <p className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            {t('chat.empty')}
          </p>
        )}
        {sessions.length > 0 && visibleSessions.length === 0 && hits.length === 0 && (
          <p className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            {t('chat.searchEmpty')}
          </p>
        )}
      </div>
      {/* 底部：用户卡 + 世界线彩蛋读数 */}
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span className="grid size-7 flex-none place-items-center rounded-full bg-foreground text-[12.5px] font-semibold text-background">
          {(username ?? t('chatShell.defaultUser')).charAt(0).toUpperCase()}
        </span>
        <span className="grid min-w-0">
          <b className="truncate text-[13.5px] font-semibold">{username ?? t('chatShell.defaultUser')}</b>
          <span className="text-[12.5px] text-muted-foreground">{t('chatShell.userRole')}</span>
          <span className="text-[10.5px] text-muted-foreground">
            {t('chatShell.currentWorldLine')}{' '}
            <span className="font-digit text-[11px] tracking-[0.05em] text-ink-2">{worldLine}</span>
          </span>
          {affinity && affinity.events.length > 0 && (
            <span data-testid="sidebar-affinity" className="text-[10.5px] text-muted-foreground">
              {t('memory.sidebar', {
                stage: t(`memory.stage.${affinity.stageKey}`),
                score: affinity.score
              })}
            </span>
          )}
        </span>
      </div>
    </aside>
  )
}
