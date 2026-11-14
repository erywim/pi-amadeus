import * as React from 'react'
import { useEffect, useState } from 'react'
import { Heart, LoaderCircle, Send } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { ProactiveGreeting, ProactiveResponse } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { fetchProactive, runProactive, saveProactive } from '@renderer/lib/api'
import { useSessionStore } from '@renderer/stores/sessionStore'

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

/**
 * 主动问候设置：只控制「什么时候可以主动说话」。
 * 真正的消息由大脑在空闲时用真实模型生成，并写进最近的桌面会话。
 */
export function ProactivePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const userId = useSessionStore((s) => s.userId)
  const [data, setData] = useState<ProactiveResponse | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [minIdle, setMinIdle] = useState(180)
  const [activeStart, setActiveStart] = useState('09:00')
  const [activeEnd, setActiveEnd] = useState('23:00')
  const [maxPerDay, setMaxPerDay] = useState(2)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [latest, setLatest] = useState<ProactiveGreeting | null>(null)

  useEffect(() => {
    if (!userId) return
    void fetchProactive(userId)
      .then((response) => {
        setData(response)
        setLatest(response.latest)
        setEnabled(response.settings.enabled)
        setMinIdle(response.settings.minIdleMinutes)
        setActiveStart(response.settings.activeStart)
        setActiveEnd(response.settings.activeEnd)
        setMaxPerDay(response.settings.maxPerDay)
      })
      .catch((error) => console.warn('[proactive] 加载失败：', error))
  }, [userId])

  if (!userId) {
    return <p className="text-[13px] text-muted-foreground">{t('proactive.loginRequired')}</p>
  }

  async function save(): Promise<void> {
    if (!userId) return
    setBusy(true)
    try {
      const settings = await saveProactive(userId, {
        enabled,
        minIdleMinutes: minIdle,
        activeStart,
        activeEnd,
        maxPerDay
      })
      setData((current) => (current ? { ...current, settings } : current))
      toast.success(t('proactive.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function runNow(): Promise<void> {
    if (!userId) return
    setRunning(true)
    try {
      const greeting = await runProactive(userId)
      setLatest(greeting)
      toast.success(t('proactive.sent'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Heart className="size-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold">{t('proactive.title')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('proactive.subtitle')}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 rounded-xl border border-border bg-card p-4">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-[13.5px] font-medium">{t('proactive.enabled')}</span>
            <span className="block text-[11.5px] text-muted-foreground">
              {t('proactive.enabledHint')}
            </span>
          </span>
          <Switch
            data-testid="proactive-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="text-[12.5px]">{t('proactive.minIdle')}</Label>
            <Input
              data-testid="proactive-min-idle"
              type="number"
              min={5}
              max={10080}
              value={minIdle}
              onChange={(e) => setMinIdle(Number(e.target.value) || 180)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px]">{t('proactive.maxPerDay')}</Label>
            <Input
              data-testid="proactive-max"
              type="number"
              min={1}
              max={20}
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(Number(e.target.value) || 2)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px]">{t('proactive.activeFrom')}</Label>
            <Input
              data-testid="proactive-start"
              type="time"
              value={activeStart}
              onChange={(e) => setActiveStart(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px]">{t('proactive.activeTo')}</Label>
            <Input
              data-testid="proactive-end"
              type="time"
              value={activeEnd}
              onChange={(e) => setActiveEnd(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button data-testid="proactive-save" size="sm" disabled={busy} onClick={() => void save()}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {t('common.confirm')}
          </Button>
          <Button
            data-testid="proactive-run"
            size="sm"
            variant="outline"
            disabled={running}
            onClick={() => void runNow()}
          >
            {running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            {t('proactive.runNow')}
          </Button>
          <span className="text-[11.5px] text-muted-foreground">
            {t('proactive.todayCount', { count: data?.todayCount ?? 0 })}
          </span>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-card p-4">
        <h3 className="text-[13.5px] font-semibold">{t('proactive.latest')}</h3>
        {latest ? (
          <div data-testid="proactive-latest" className="mt-2">
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
              {latest.content}
            </p>
            <p className="mt-1 font-mono text-[10.5px] text-muted-foreground">
              {timeFormatter.format(latest.createdAt)}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] text-muted-foreground">{t('proactive.empty')}</p>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          {t('proactive.hint')}
        </p>
      </div>
    </div>
  )
}
