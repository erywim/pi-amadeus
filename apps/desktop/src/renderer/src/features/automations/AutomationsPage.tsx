import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  Pencil,
  Play,
  Plus,
  Timer,
  Trash2
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { AutomationInput, AutomationItem, AutomationSchedule } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { cn } from '@renderer/lib/utils'
import { useAutomationStore } from '@renderer/stores/automationStore'
import { useSessionStore } from '@renderer/stores/sessionStore'

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

interface FormState {
  name: string
  prompt: string
  schedule: AutomationSchedule
  intervalMinutes: number
  timeOfDay: string
  runAt: string
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  prompt: '',
  schedule: 'daily',
  intervalMinutes: 60,
  timeOfDay: '09:00',
  runAt: '',
  enabled: true
}

/**
 * 自动化任务页：任务由服务端调度器真实触发，运行结果落进独立会话。
 * 页面只负责配置与展示，不在前端计时——关掉窗口任务照样执行。
 */
export default function AutomationsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const userId = useSessionStore((s) => s.userId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const items = useAutomationStore((s) => s.items)
  const loaded = useAutomationStore((s) => s.loaded)
  const load = useAutomationStore((s) => s.load)
  const create = useAutomationStore((s) => s.create)
  const update = useAutomationStore((s) => s.update)
  const remove = useAutomationStore((s) => s.remove)
  const run = useAutomationStore((s) => s.run)
  const loadMessages = useAutomationStore((s) => s.loadMessages)
  const messages = useAutomationStore((s) => s.messages)

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) return
    void load(userId)
  }, [userId, load])

  // 任务运行是服务端异步的：页面开着时轻量轮询，关掉页面也不影响执行
  useEffect(() => {
    if (!userId) return
    const timer = window.setInterval(() => {
      void load(userId)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [userId, load])

  const runningCount = useMemo(
    () => items.filter((item) => item.lastStatus === 'running').length,
    [items]
  )

  if (!userId) {
    return (
      <div className="grid h-full place-items-center">
        <p className="text-[13px] text-muted-foreground">{t('automations.loginRequired')}</p>
      </div>
    )
  }

  function openCreate(): void {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  function openEdit(item: AutomationItem): void {
    setEditingId(item.id)
    setForm({
      name: item.name,
      prompt: item.prompt,
      schedule: item.schedule,
      intervalMinutes: item.intervalMinutes,
      timeOfDay: item.timeOfDay || '09:00',
      runAt: item.runAt ? toLocalInput(item.runAt) : '',
      enabled: item.enabled
    })
    setFormOpen(true)
  }

  async function handleSubmit(): Promise<void> {
    const name = form.name.trim()
    const prompt = form.prompt.trim()
    if (!name || !prompt) return
    const payload: AutomationInput = {
      name,
      prompt,
      schedule: form.schedule,
      intervalMinutes: form.intervalMinutes,
      timeOfDay: form.timeOfDay,
      runAt: form.schedule === 'once' && form.runAt ? Date.parse(form.runAt) : null,
      enabled: form.enabled
    }
    setBusy(true)
    try {
      if (editingId) {
        await update(editingId, payload)
        toast.success(t('automations.saved'))
      } else {
        await create(userId!, payload)
        toast.success(t('automations.created'))
      }
      setFormOpen(false)
      setEditingId(null)
      setForm(EMPTY_FORM)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleToggle(item: AutomationItem, enabled: boolean): Promise<void> {
    try {
      await update(item.id, { enabled })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleRun(item: AutomationItem): Promise<void> {
    try {
      await run(item.id)
      toast.success(t('automations.started'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (confirmId !== id) {
      setConfirmId(id)
      window.setTimeout(() => setConfirmId((current) => (current === id ? null : current)), 3000)
      return
    }
    try {
      await remove(id)
      setConfirmId(null)
      toast.success(t('automations.deleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function toggleResult(item: AutomationItem): Promise<void> {
    if (expandedId === item.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(item.id)
    if (!messages[item.id]) await loadMessages(item.id)
  }

  function openSession(item: AutomationItem): void {
    selectSession(item.sessionId)
    navigate('/text')
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
              <CalendarClock className="size-5 text-primary" strokeWidth={1.8} />
              {t('automations.title')}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              {t('automations.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {runningCount > 0 && (
              <Badge variant="outline" className="gap-1 text-[11px]">
                <Loader2 className="size-3 animate-spin" />
                {t('automations.running')} {runningCount}
              </Badge>
            )}
            <Button data-testid="automation-new" size="sm" onClick={openCreate}>
              <Plus className="size-3.5" />
              {t('automations.create')}
            </Button>
          </div>
        </div>

        {formOpen && (
          <section className="mt-4 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">
                {editingId ? t('automations.edit') : t('automations.create')}
              </h2>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="text-[12.5px] text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-[12.5px] text-muted-foreground">{t('automations.name')}</span>
                <Input
                  data-testid="automation-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('automations.namePlaceholder')}
                  className="h-9 text-[13px]"
                />
              </label>
              <div className="space-y-1">
                <span className="text-[12.5px] text-muted-foreground">{t('automations.schedule')}</span>
                <div className="flex gap-1 rounded-[10px] border border-border bg-surface-soft p-1">
                  {(['interval', 'daily', 'once'] as const).map((schedule) => (
                    <button
                      key={schedule}
                      type="button"
                      data-testid={`automation-schedule-${schedule}`}
                      onClick={() => setForm({ ...form, schedule })}
                      className={cn(
                        'flex-1 rounded-[7px] px-2 py-1.5 text-[12.5px] transition-colors',
                        form.schedule === schedule
                          ? 'bg-surface font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t(`automations.${schedule}`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {form.schedule === 'interval' && (
                <label className="space-y-1">
                  <span className="text-[12.5px] text-muted-foreground">
                    {t('automations.intervalMinutes')}
                  </span>
                  <Input
                    data-testid="automation-interval"
                    type="number"
                    min={5}
                    max={10080}
                    value={form.intervalMinutes}
                    onChange={(e) =>
                      setForm({ ...form, intervalMinutes: Number(e.target.value) || 60 })
                    }
                    className="h-9 text-[13px]"
                  />
                </label>
              )}
              {form.schedule === 'daily' && (
                <label className="space-y-1">
                  <span className="text-[12.5px] text-muted-foreground">
                    {t('automations.timeOfDay')}
                  </span>
                  <Input
                    data-testid="automation-time"
                    type="time"
                    value={form.timeOfDay}
                    onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })}
                    className="h-9 text-[13px]"
                  />
                </label>
              )}
              {form.schedule === 'once' && (
                <label className="space-y-1">
                  <span className="text-[12.5px] text-muted-foreground">
                    {t('automations.runAt')}
                  </span>
                  <Input
                    data-testid="automation-runat"
                    type="datetime-local"
                    value={form.runAt}
                    onChange={(e) => setForm({ ...form, runAt: e.target.value })}
                    className="h-9 text-[13px]"
                  />
                </label>
              )}
              <label className="flex items-end gap-2 pb-1.5">
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                />
                <span className="text-[13px]">{t('automations.enabled')}</span>
              </label>
            </div>

            <label className="mt-3 block space-y-1">
              <span className="text-[12.5px] text-muted-foreground">{t('automations.prompt')}</span>
              <Textarea
                data-testid="automation-prompt"
                rows={4}
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder={t('automations.promptPlaceholder')}
                className="resize-y text-[13px]"
              />
            </label>

            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setFormOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                data-testid="automation-save"
                size="sm"
                disabled={busy || !form.name.trim() || !form.prompt.trim()}
                onClick={() => void handleSubmit()}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('common.confirm')}
              </Button>
            </div>
          </section>
        )}

        <div className="mt-4 space-y-2.5">
          {items.map((item) => {
            const status = statusKey(item)
            return (
              <article
                key={item.id}
                data-testid="automation-item"
                className="rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-border bg-surface-soft">
                    {item.schedule === 'interval' ? (
                      <Timer className="size-4 text-primary" strokeWidth={1.8} />
                    ) : (
                      <Clock className="size-4 text-primary" strokeWidth={1.8} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14.5px] font-semibold">{item.name}</h3>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10.5px]',
                          status === 'success' && 'border-mint/60 text-mint',
                          status === 'error' && 'border-destructive/50 text-destructive',
                          status === 'running' && 'border-primary/50 text-primary'
                        )}
                      >
                        {status === 'running' && <Loader2 className="mr-1 size-2.5 animate-spin" />}
                        {t(`automations.status.${status}`)}
                      </Badge>
                      <span className="text-[11.5px] text-muted-foreground">
                        {scheduleLabel(item, t)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      {item.prompt}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
                      <span>
                        {t('automations.nextRun')}：
                        {item.enabled && item.nextRunAt
                          ? dateTimeFormatter.format(item.nextRunAt)
                          : t('automations.never')}
                      </span>
                      <span>
                        {t('automations.lastRun')}：
                        {item.lastRunAt
                          ? dateTimeFormatter.format(item.lastRunAt)
                          : t('automations.never')}
                      </span>
                    </div>
                    {item.lastStatus === 'error' && item.lastError && (
                      <p className="mt-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11.5px] text-destructive">
                        {item.lastError}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      data-testid="automation-enabled"
                      checked={item.enabled}
                      onCheckedChange={(enabled) => void handleToggle(item, enabled)}
                    />
                    <Button
                      data-testid="automation-run"
                      size="sm"
                      variant="outline"
                      disabled={item.lastStatus === 'running'}
                      onClick={() => void handleRun(item)}
                    >
                      {item.lastStatus === 'running' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {t('automations.runNow')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(item)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={confirmId === item.id ? 'text-destructive' : ''}
                      title={confirmId === item.id ? t('automations.confirmDelete') : t('common.delete')}
                      onClick={() => void handleDelete(item.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {(item.lastResult || item.lastRunAt) && (
                  <div className="mt-2.5 border-t border-border pt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="automation-view-result"
                        onClick={() => void toggleResult(item)}
                        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                      >
                        {expandedId === item.id ? (
                          <ChevronUp className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                        {expandedId === item.id
                          ? t('automations.hideResult')
                          : t('automations.viewResult')}
                      </button>
                      {item.lastRunAt && (
                        <button
                          type="button"
                          onClick={() => openSession(item)}
                          className="text-[12px] text-primary hover:underline"
                        >
                          {t('automations.openSession')}
                        </button>
                      )}
                    </div>
                    {expandedId === item.id && (
                      <div
                        data-testid="automation-result"
                        className="mt-2 max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] border border-border bg-surface-soft p-3 text-[13px] leading-relaxed"
                      >
                        {item.lastResult || t('automations.never')}
                        {(messages[item.id] ?? []).length > 2 && (
                          <button
                            type="button"
                            onClick={() => openSession(item)}
                            className="mt-2 block text-[12px] text-primary hover:underline"
                          >
                            {t('automations.openSession')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </article>
            )
          })}
          {items.length === 0 && loaded && (
            <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center">
              <p className="text-[14px] font-medium">{t('automations.empty')}</p>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
                {t('automations.emptyHint')}
              </p>
              <Button size="sm" className="mt-3" onClick={openCreate}>
                <Plus className="size-3.5" />
                {t('automations.create')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function statusKey(item: AutomationItem): 'success' | 'error' | 'running' | 'idle' {
  if (item.lastStatus === 'running') return 'running'
  if (item.lastStatus === 'success') return 'success'
  if (item.lastStatus === 'error') return 'error'
  return 'idle'
}

function scheduleLabel(
  item: AutomationItem,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (item.schedule === 'interval') {
    return t('automations.scheduleLabel.interval', { minutes: item.intervalMinutes })
  }
  if (item.schedule === 'daily') {
    return t('automations.scheduleLabel.daily', { time: item.timeOfDay })
  }
  return t('automations.scheduleLabel.once')
}

/** 时间戳 → datetime-local 输入值（本地时区，精确到分钟） */
function toLocalInput(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
