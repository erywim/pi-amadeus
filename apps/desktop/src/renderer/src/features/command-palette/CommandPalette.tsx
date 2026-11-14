import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BarChart3,
  Blocks,
  BookOpen,
  Brain,
  CalendarClock,
  CornerDownLeft,
  Download,
  GitBranch,
  Keyboard,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Terminal,
  UserRound
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { MessageSearchHit } from '@pi-amadeus/shared'
import { searchMessagesApi } from '@renderer/lib/api'
import { exportSessionMarkdown } from '@renderer/lib/exportSession'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore } from '@renderer/stores/uiStore'

type SectionKey = 'action' | 'page' | 'session' | 'message'

interface PaletteItem {
  id: string
  section: SectionKey
  title: string
  subtitle?: string
  icon: LucideIcon
  run: () => void | Promise<void>
}

/**
 * 命令面板（⌘/Ctrl+K）：一处找到动作、页面、会话与消息正文。
 * 空查询显示常用动作与最近会话；输入后按相关度合并四类结果。
 */
export function CommandPalette(): React.JSX.Element | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const open = useUiStore((s) => s.commandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const setBranchTreeOpen = useUiStore((s) => s.setBranchTreeOpen)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const createSession = useSessionStore((s) => s.createSession)
  const selectSession = useSessionStore((s) => s.selectSession)
  const userId = useSessionStore((s) => s.userId)
  const theme = useSettingsStore((s) => s.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [hits, setHits] = useState<MessageSearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const activeSession = sessions.find((session) => session.id === activeSessionId)

  // 打开时重置状态并聚焦；关闭后清空查询，下次打开是干净的
  useEffect(() => {
    if (!open) {
      setQuery('')
      setHits([])
      setActiveIndex(0)
      return
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(timer)
  }, [open])

  // 消息正文搜索：空查询/单字不请求；350ms 防抖，避免每次按键都扫库
  useEffect(() => {
    if (!open) return
    const keyword = query.trim()
    if (!userId || keyword.length < 2) {
      setHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      searchMessagesApi(userId, keyword)
        .then((result) => {
          if (!cancelled) setHits(result)
        })
        .catch((error) => console.warn('[palette] 消息搜索失败：', error))
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, userId])

  const close = (): void => setOpen(false)

  async function runExport(): Promise<void> {
    if (!activeSession) return
    try {
      const filename = await exportSessionMarkdown(activeSession, {
        user: t('chat.exportUser'),
        assistant: 'Amadeus',
        attachments: t('chat.attachments'),
        untitled: t('chatShell.untitledTask')
      })
      toast.success(t('chat.exported', { name: filename }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const actions = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: 'action:new',
        section: 'action',
        title: t('palette.newSession'),
        subtitle: t('palette.newSessionHint'),
        icon: Plus,
        run: () => {
          createSession()
          navigate('/text')
        }
      },
      {
        id: 'action:theme',
        section: 'action',
        title: theme === 'paper' ? t('palette.toDark') : t('palette.toLight'),
        subtitle: t('palette.themeHint'),
        icon: theme === 'paper' ? Moon : Sun,
        run: () => setTheme(theme === 'paper' ? 'cyber' : 'paper')
      },
      {
        id: 'action:settings',
        section: 'action',
        title: t('nav.settings'),
        subtitle: t('palette.settingsHint'),
        icon: Settings,
        run: () => navigate('/settings')
      },
      {
        id: 'action:shortcuts',
        section: 'action',
        title: t('shortcuts.title'),
        subtitle: t('palette.shortcutsHint'),
        icon: Keyboard,
        run: () => useUiStore.getState().setShortcutsOpen(true)

      }
    ]
    if (activeSession) {
      items.push(
        {
          id: 'action:tree',
          section: 'action',
          title: t('branchTree.open'),
          subtitle: t('palette.treeHint'),
          icon: GitBranch,
          run: () => setBranchTreeOpen(true)
        },
        {
          id: 'action:export',
          section: 'action',
          title: t('chat.exportMarkdown'),
          subtitle: t('palette.exportHint'),
          icon: Download,
          run: runExport
        }
      )
    }
    return items
  }, [t, theme, activeSession, createSession, navigate, setTheme, setBranchTreeOpen])
  // run 闭包依赖 t / activeSession；actions 的 useMemo 已把它们列入依赖

  const pages = useMemo<PaletteItem[]>(
    () => [
      { id: 'page:text', section: 'page', title: t('nav.text'), icon: Terminal, run: () => navigate('/text') },
      {
        id: 'page:companion',
        section: 'page',
        title: t('nav.companion'),
        icon: UserRound,
        run: () => navigate('/companion')
      },
      { id: 'page:memory', section: 'page', title: t('nav.memory'), icon: Brain, run: () => navigate('/memory') },
      {
        id: 'page:knowledge',
        section: 'page',
        title: t('nav.knowledge'),
        icon: BookOpen,
        run: () => navigate('/knowledge')
      },
      {
        id: 'page:automations',
        section: 'page',
        title: t('nav.automations'),
        icon: CalendarClock,
        run: () => navigate('/automations')
      },
      { id: 'page:plugins', section: 'page', title: t('nav.plugins'), icon: Blocks, run: () => navigate('/plugins') },
      {
        id: 'page:dashboard',
        section: 'page',
        title: t('nav.dashboard'),
        icon: BarChart3,
        run: () => navigate('/dashboard')
      }
    ],
    [t, navigate]
  )

  const items = useMemo<PaletteItem[]>(() => {
    const keyword = query.trim()
    const score = (text: string): number => fuzzyScore(text, keyword)
    const take = (source: PaletteItem[], limit?: number): PaletteItem[] =>
      source
        .map((item) => ({
          item,
          score: score(`${item.title} ${item.subtitle ?? ''}`)
        }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.item)

    const actionItems = take(actions)
    const pageItems = take(pages)
    const sessionItems = take(
      sessions.map(
        (session): PaletteItem => ({
          id: `session:${session.id}`,
          section: 'session',
          title: session.title || t('chatShell.untitledTask'),
          subtitle: t('palette.sessionSubtitle', {
            count: Math.ceil((session.messageCount ?? 0) / 2)
          }),
          icon: MessageSquare,
          run: () => {
            selectSession(session.id)
            navigate('/text')
          }
        })
      ),
      keyword ? 8 : 5
    )
    const messageItems = hits.slice(0, 6).map(
      (hit): PaletteItem => ({
        id: `message:${hit.messageId}`,
        section: 'message',
        title: hit.sessionTitle || t('chatShell.untitledTask'),
        subtitle: hit.snippet,
        icon: MessageSquare,
        run: () => {
          selectSession(hit.sessionId)
          navigate('/text')
        }
      })
    )
    return [...actionItems, ...pageItems, ...sessionItems, ...messageItems]
  }, [actions, pages, sessions, hits, query, selectSession, navigate, t])

  // 结果变化后把选中项收回到有效范围，避免列表变短时高亮消失
  useEffect(() => {
    setActiveIndex((index) => (items.length === 0 ? 0 : Math.min(index, items.length - 1)))
  }, [items.length])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open) return null

  const sections: Array<{ key: SectionKey; label: string }> = [
    { key: 'action', label: t('palette.actions') },
    { key: 'page', label: t('palette.pages') },
    { key: 'session', label: t('palette.sessions') },
    { key: 'message', label: t('palette.messages') }
  ]

  function choose(item: PaletteItem | undefined): void {
    if (!item) return
    close()
    void item.run()
  }

  let flatIndex = -1
  return (
    <div
      className="fixed inset-0 z-[70] flex justify-center bg-black/35 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      data-testid="palette-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        data-testid="command-palette"
        className="h-fit w-full max-w-[640px] overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(10,12,16,0.28)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            data-testid="palette-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => (items.length ? (index + 1) % items.length : 0))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) =>
                  items.length ? (index - 1 + items.length) % items.length : 0
                )
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(items[activeIndex])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-surface-soft px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[min(58vh,460px)] overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">
              {t('palette.empty')}
            </p>
          ) : (
            sections.map(({ key, label }) => {
              const sectionItems = items.filter((item) => item.section === key)
              if (sectionItems.length === 0) return null
              return (
                <section key={key} className="mb-1">
                  <h3 className="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    {label}
                  </h3>
                  {sectionItems.map((item) => {
                    flatIndex += 1
                    const index = flatIndex
                    const Icon = item.icon
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-testid="palette-item"
                        data-palette-index={index}
                        data-palette-id={item.id}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(item)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors',
                          index === activeIndex ? 'bg-accent-soft text-foreground' : 'text-ink-2 hover:bg-surface-soft'
                        )}
                      >
                        <span
                          className={cn(
                            'grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-surface',
                            index === activeIndex && 'border-primary/30 text-primary'
                          )}
                        >
                          <Icon className="size-3.5" strokeWidth={1.8} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">{item.title}</span>
                          {item.subtitle && (
                            <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                              {item.subtitle}
                            </span>
                          )}
                        </span>
                        {index === activeIndex ? (
                          <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ArrowRight className="size-3.5 shrink-0 text-transparent" />
                        )}
                      </button>
                    )
                  })}
                </section>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>{t('palette.footer')}</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  )
}

/** 轻量子序列匹配：连续命中与开头命中得分更高；-1 = 不匹配 */
function fuzzyScore(text: string, query: string): number {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return 1
  const lower = text.toLowerCase()
  const direct = lower.indexOf(normalized)
  if (direct === 0) return 100
  if (direct > 0) return 80 - Math.min(40, direct)
  let cursor = 0
  let score = 20
  let streak = 0
  for (const char of normalized) {
    const found = lower.indexOf(char, cursor)
    if (found < 0) return -1
    if (found === cursor) {
      streak += 1
      score += 2 + streak
    } else {
      streak = 0
      score -= 1
    }
    cursor = found + 1
  }
  return score
}
