import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Brain, Heart, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { MemoryKind } from '@pi-amadeus/shared'
import { AFFINITY_STAGES } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { cn } from '@renderer/lib/utils'
import { useMemoryStore } from '@renderer/stores/memoryStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { AreaChart } from '../dashboard/charts'

const KINDS: MemoryKind[] = ['fact', 'preference', 'event', 'relationship']
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' })

/**
 * 记忆与关系页：左边是可检索/可编辑的长期记忆，右边是由真实互动累计的好感度。
 * 所有数字都来自数据库里的真实记录；没有发生过的事不会凭空出现。
 */
export default function MemoryPage(): React.JSX.Element {
  const { t } = useTranslation()
  const userId = useSessionStore((s) => s.userId)
  const memories = useMemoryStore((s) => s.memories)
  const total = useMemoryStore((s) => s.total)
  const affinity = useMemoryStore((s) => s.affinity)
  const loaded = useMemoryStore((s) => s.loaded)
  const load = useMemoryStore((s) => s.load)
  const search = useMemoryStore((s) => s.search)
  const add = useMemoryStore((s) => s.add)
  const update = useMemoryStore((s) => s.update)
  const remove = useMemoryStore((s) => s.remove)

  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [draftKind, setDraftKind] = useState<MemoryKind>('fact')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!userId) return
    void load(userId)
  }, [userId, load])

  // 搜索做 300ms 防抖：每敲一个字就打一次接口没有意义
  useEffect(() => {
    if (!userId) return
    const timer = window.setTimeout(() => {
      void search(userId, query)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, userId, search])

  const stage = AFFINITY_STAGES[affinity?.stage ?? 0] ?? AFFINITY_STAGES[0]
  const stageLabel = t(`memory.stage.${affinity?.stageKey ?? 'stranger'}`)
  const stageFloor = stage.min
  const stageCeil = affinity?.nextAt ?? null
  const progress =
    stageCeil === null
      ? 1
      : Math.min(1, Math.max(0, ((affinity?.score ?? 0) - stageFloor) / (stageCeil - stageFloor)))
  const chartData = useMemo(
    () =>
      (affinity?.daily ?? []).map((point) => ({
        label: `${Number(point.day.slice(5, 7))}/${Number(point.day.slice(8, 10))}`,
        value: point.score
      })),
    [affinity]
  )

  if (!userId) {
    return (
      <div className="grid h-full place-items-center">
        <p className="text-[13px] text-muted-foreground">{t('memory.loginRequired')}</p>
      </div>
    )
  }

  async function handleAdd(): Promise<void> {
    const content = draft.trim()
    if (!content || !userId) return
    setBusy(true)
    try {
      await add(userId, content, draftKind)
      setDraft('')
      toast.success(t('memory.added'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveEdit(): Promise<void> {
    const content = editingText.trim()
    if (!editingId || !content) return
    setBusy(true)
    try {
      await update(editingId, { content })
      setEditingId(null)
      toast.success(t('memory.updated'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (confirmId !== id) {
      setConfirmId(id)
      window.setTimeout(() => setConfirmId((current) => (current === id ? null : current)), 3000)
      return
    }
    setBusy(true)
    try {
      await remove(id)
      setConfirmId(null)
      toast.success(t('memory.deleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
              <Brain className="size-5 text-primary" strokeWidth={1.8} />
              {t('memory.title')}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              {t('memory.subtitle')}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
          {/* 记忆列表 */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-1 items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 focus-within:border-primary">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <Input
                  data-testid="memory-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('memory.search')}
                  aria-label={t('memory.search')}
                  className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
                />
              </div>
              <span className="text-[12px] text-muted-foreground">
                {t('memory.count', { count: total })}
              </span>
            </div>

            <div className="mt-3 rounded-[10px] border border-border bg-surface-soft p-2.5">
              <Textarea
                data-testid="memory-draft"
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('memory.addPlaceholder')}
                className="min-h-0 resize-none border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {KINDS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDraftKind(value)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                      draftKind === value
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-surface'
                    )}
                  >
                    {t(`memory.kind.${value}`)}
                  </button>
                ))}
                <span className="flex-1" />
                <Button
                  data-testid="memory-add"
                  size="sm"
                  disabled={busy || !draft.trim()}
                  onClick={() => void handleAdd()}
                >
                  <Plus className="size-3.5" />
                  {t('memory.add')}
                </Button>
              </div>
            </div>

            <div className="mt-3 grid gap-2">
              {loaded && memories.length === 0 && (
                <p className="py-10 text-center text-[12.5px] leading-relaxed text-muted-foreground">
                  {query.trim() ? t('memory.emptySearch') : t('memory.empty')}
                </p>
              )}
              {memories.map((memory) => (
                <div
                  key={memory.id}
                  data-testid="memory-item"
                  data-memory-id={memory.id}
                  className="group rounded-[10px] border border-border px-3 py-2.5 transition-colors hover:bg-surface-soft"
                >
                  {editingId === memory.id ? (
                    <div className="grid gap-2">
                      <Textarea
                        rows={2}
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        className="min-h-0 resize-none text-[13px]"
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          {t('common.cancel')}
                        </Button>
                        <Button size="sm" disabled={busy || !editingText.trim()} onClick={() => void handleSaveEdit()}>
                          {t('common.confirm')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">{memory.content}</p>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <button
                            type="button"
                            data-testid="memory-pin"
                            title={memory.pinned ? t('memory.unpin') : t('memory.pin')}
                            aria-label={memory.pinned ? t('memory.unpin') : t('memory.pin')}
                            onClick={() =>
                              void update(memory.id, { pinned: !memory.pinned }).catch((error: unknown) =>
                                toast.error(error instanceof Error ? error.message : String(error))
                              )
                            }
                            className="rounded p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
                          >
                            {memory.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                          </button>
                          <button
                            type="button"
                            data-testid="memory-edit"
                            title={t('memory.edit')}
                            aria-label={t('memory.edit')}
                            onClick={() => {
                              setEditingId(memory.id)
                              setEditingText(memory.content)
                            }}
                            className="rounded p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
                          >
                            <span className="text-[11px]">{t('memory.edit')}</span>
                          </button>
                          <button
                            type="button"
                            data-testid="memory-delete"
                            title={t('memory.delete')}
                            aria-label={t('memory.delete')}
                            onClick={() => void handleDelete(memory.id)}
                            className={cn(
                              'rounded p-1 text-muted-foreground hover:bg-surface hover:text-destructive',
                              confirmId === memory.id && 'text-destructive'
                            )}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          {t(`memory.kind.${memory.kind}`)}
                        </Badge>
                        {memory.pinned && <span className="text-primary">{t('memory.pinned')}</span>}
                        <span>{dateFormatter.format(memory.createdAt)}</span>
                        {memory.lastUsedAt && (
                          <span className="text-muted-foreground/70">
                            {t('memory.lastUsed', { date: dateFormatter.format(memory.lastUsedAt) })}
                          </span>
                        )}
                        {confirmId === memory.id && (
                          <span className="text-destructive">{t('memory.confirmDelete')}</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* 好感度 */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="flex items-center gap-1.5 text-[13.5px] font-semibold">
              <Heart className="size-4 text-destructive" strokeWidth={1.8} />
              {t('memory.affinity.title')}
            </h2>
            <div className="mt-3 flex items-end gap-2">
              <span data-testid="affinity-score" className="text-[34px] font-semibold leading-none tabular-nums">
                {affinity?.score ?? 0}
              </span>
              <span className="pb-1 text-[12.5px] text-muted-foreground">{t('memory.affinity.points')}</span>
              <span className="flex-1" />
              <Badge variant="outline" className="mb-1 border-primary/30 px-2 py-0.5 text-[11px] text-primary">
                {stageLabel}
              </Badge>
            </div>
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {stageCeil === null
                  ? t('memory.affinity.max')
                  : t('memory.affinity.next', { next: stageCeil - (affinity?.score ?? 0) })}
              </p>
            </div>
            <div className="mt-4">
              <AreaChart data={chartData} height={90} color="var(--destructive)" />
              <p className="mt-1 text-[11px] text-muted-foreground">{t('memory.affinity.trend')}</p>
            </div>
            <div className="mt-4">
              <h3 className="text-[12px] font-semibold text-ink-2">{t('memory.affinity.events')}</h3>
              <div className="mt-2 grid max-h-64 gap-1.5 overflow-y-auto pr-1">
                {(affinity?.events ?? []).length === 0 && (
                  <p className="py-4 text-center text-[11.5px] text-muted-foreground">
                    {t('memory.affinity.empty')}
                  </p>
                )}
                {(affinity?.events ?? []).map((event, index) => (
                  <div
                    key={`${event.createdAt}-${index}`}
                    className="flex items-center gap-2 text-[11.5px] text-muted-foreground"
                  >
                    <span className="text-mint">+{event.delta}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{event.reason}</span>
                    <span>{dateFormatter.format(event.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
              {t('memory.affinity.footnote')}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
