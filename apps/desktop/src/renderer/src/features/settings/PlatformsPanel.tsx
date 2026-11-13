import * as React from 'react'
import { useEffect, useState } from 'react'
import { Copy, LoaderCircle, MessageCircle, Pencil, Send, Trash2, Webhook } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { PlatformItem, PlatformKind } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import {
  BRAIN_URL,
  createPlatformApi,
  deletePlatformApi,
  fetchPlatforms,
  setPlatformEnabledApi,
  testPlatformApi,
  updatePlatformApi
} from '@renderer/lib/api'
import { copyText } from '@renderer/lib/clipboard'
import { cn } from '@renderer/lib/utils'

const KIND_ICONS = {
  telegram: Send,
  onebot: MessageCircle,
  webhook: Webhook
} as const

const KINDS: PlatformKind[] = ['telegram', 'onebot', 'webhook']

interface FormState {
  name: string
  token: string
  baseUrl: string
  testChatId: string
  url: string
  accessToken: string
  outboundUrl: string
  secret: string
}

const EMPTY_FORM: FormState = {
  name: '',
  token: '',
  baseUrl: '',
  testChatId: '',
  url: '',
  accessToken: '',
  outboundUrl: '',
  secret: ''
}

/**
 * 通讯平台（参考 AstrBot 的多平台接入）：Telegram / OneBot v11（QQ）/ 通用 Webhook。
 * 卡片显示适配器实时状态；每 5 秒轮询一次，配置变更后立即同步。
 */
export function PlatformsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [platforms, setPlatforms] = useState<PlatformItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; platform: PlatformItem } | null>(null)
  const [kind, setKind] = useState<PlatformKind>('telegram')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  async function load(): Promise<void> {
    try {
      setPlatforms(await fetchPlatforms())
    } catch (error) {
      console.warn('[platforms] 加载失败：', error)
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    void load()
    // 适配器状态是运行时的：面板开着时定时刷新，关掉就停
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [])

  function openCreate(): void {
    setKind('telegram')
    setForm(EMPTY_FORM)
    setDialog({ mode: 'create' })
  }

  function openEdit(platform: PlatformItem): void {
    setKind(platform.kind)
    const config = platform.config as Record<string, unknown>
    const text = (key: string): string => (typeof config[key] === 'string' ? (config[key] as string) : '')
    setForm({
      ...EMPTY_FORM,
      name: platform.name,
      baseUrl: text('baseUrl'),
      testChatId: text('testChatId'),
      url: text('url'),
      outboundUrl: text('outboundUrl')
    })
    setDialog({ mode: 'edit', platform })
  }

  function configOf(): Record<string, string> {
    if (kind === 'telegram') {
      return {
        ...(form.token ? { token: form.token } : {}),
        baseUrl: form.baseUrl,
        testChatId: form.testChatId
      }
    }
    if (kind === 'onebot') {
      return {
        url: form.url,
        ...(form.accessToken ? { accessToken: form.accessToken } : {}),
        testChatId: form.testChatId
      }
    }
    return {
      outboundUrl: form.outboundUrl,
      ...(form.secret ? { secret: form.secret } : {})
    }
  }

  async function save(): Promise<void> {
    if (!dialog) return
    setBusy('save')
    try {
      if (dialog.mode === 'create') {
        await createPlatformApi({ kind, name: form.name, enabled: true, config: configOf() })
      } else {
        await updatePlatformApi(dialog.platform.id, { name: form.name, config: configOf() })
      }
      toast.success(t('settings.platforms.saved'))
      setDialog(null)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function toggle(platform: PlatformItem, enabled: boolean): Promise<void> {
    setBusy(platform.id)
    try {
      const updated = await setPlatformEnabledApi(platform.id, enabled)
      setPlatforms((list) => list.map((item) => (item.id === platform.id ? updated : item)))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function test(platform: PlatformItem): Promise<void> {
    setTesting(platform.id)
    try {
      await testPlatformApi(platform.id)
      toast.success(t('settings.platforms.testSent'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(null)
    }
  }

  async function remove(platform: PlatformItem): Promise<void> {
    if (confirmDelete !== platform.id) {
      setConfirmDelete(platform.id)
      window.setTimeout(
        () => setConfirmDelete((current) => (current === platform.id ? null : current)),
        3000
      )
      return
    }
    setBusy(platform.id)
    try {
      await deletePlatformApi(platform.id)
      setPlatforms((list) => list.filter((item) => item.id !== platform.id))
      setConfirmDelete(null)
      toast.success(t('settings.platforms.deleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const editing = dialog?.mode === 'edit' ? dialog.platform : null
  const canSave =
    form.name.trim().length > 0 &&
    (kind === 'telegram'
      ? Boolean(form.token) || Boolean(editing?.config.tokenSet)
      : kind === 'onebot'
        ? Boolean(form.url)
        : Boolean(form.outboundUrl))

  return (
    <div className="max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t('settings.platforms.title')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('settings.platforms.desc')}
          </p>
        </div>
        <Button data-testid="platform-add" variant="outline" size="sm" onClick={openCreate}>
          {t('settings.platforms.add')}
        </Button>
      </div>

      <div className="mt-4 grid gap-2">
        {loaded && platforms.length === 0 && (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            {t('settings.platforms.empty')}
          </p>
        )}
        {platforms.map((platform) => {
          const Icon = KIND_ICONS[platform.kind]
          const status = platform.status
          const config = platform.config as Record<string, unknown>
          const summary =
            platform.kind === 'telegram'
              ? `${typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl : 'api.telegram.org'}`
              : platform.kind === 'onebot'
                ? String(config.url ?? '')
                : String(config.outboundUrl ?? '')
          return (
            <div
              key={platform.id}
              data-testid="platform-row"
              data-platform-id={platform.id}
              className="rounded-md border border-border bg-card px-3.5 py-3"
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <b className="truncate text-[13.5px] font-semibold">{platform.name}</b>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                      {t(`settings.platforms.kind.${platform.kind}`)}
                    </Badge>
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        status.state === 'running'
                          ? 'bg-mint'
                          : status.state === 'error'
                            ? 'bg-destructive'
                            : 'bg-line-strong'
                      )}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      {t(`settings.platforms.state.${status.state}`)}
                    </span>
                  </div>
                  {summary && (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{summary}</p>
                  )}
                  {status.state === 'running' && status.detail && platform.kind !== 'webhook' && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{status.detail}</p>
                  )}
                  {status.state === 'error' && status.detail && (
                    <p className="mt-1 break-words text-[11px] text-destructive">{status.detail}</p>
                  )}
                  {platform.kind === 'webhook' && (
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(`${BRAIN_URL}/api/platforms/${platform.id}/webhook`)
                        toast.success(t('common.copied'))
                      }}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="size-3" />
                      {t('settings.platforms.copyWebhook')}
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    data-testid="platform-enabled"
                    checked={platform.enabled}
                    disabled={busy === platform.id}
                    onCheckedChange={(checked) => void toggle(platform, checked)}
                  />
                  <Button
                    data-testid="platform-test"
                    variant="ghost"
                    size="sm"
                    disabled={testing === platform.id || !platform.enabled}
                    onClick={() => void test(platform)}
                  >
                    {testing === platform.id ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      t('settings.platforms.test')
                    )}
                  </Button>
                  <Button data-testid="platform-edit" variant="ghost" size="sm" onClick={() => openEdit(platform)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    data-testid="platform-delete"
                    variant={confirmDelete === platform.id ? 'destructive' : 'ghost'}
                    size="sm"
                    disabled={busy === platform.id}
                    onClick={() => void remove(platform)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-4 rounded-md border border-border bg-card px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        {t('settings.platforms.bindHint')}
      </p>

      <Dialog open={dialog !== null} onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto rounded-xl">
          <DialogHeader>
            <DialogTitle className="text-[17px]">
              {dialog?.mode === 'edit' ? t('settings.platforms.editTitle') : t('settings.platforms.addTitle')}
            </DialogTitle>
            <DialogDescription className="text-[12.5px]">
              {t('settings.platforms.dialogDesc')}
            </DialogDescription>
          </DialogHeader>

          {dialog?.mode === 'create' && (
            <div className="flex gap-1.5">
              {KINDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`platform-kind-${value}`}
                  onClick={() => setKind(value)}
                  className={cn(
                    'flex-1 rounded-lg border px-2 py-2 text-[12px] transition-colors',
                    kind === value
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-surface-soft'
                  )}
                >
                  {t(`settings.platforms.kind.${value}`)}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-3">
            <Field
              testId="platform-name"
              label={t('settings.platforms.name')}
              value={form.name}
              onChange={(value) => setForm({ ...form, name: value })}
              placeholder={t('settings.platforms.namePlaceholder')}
            />
            {kind === 'telegram' && (
              <>
                <Field
                  testId="platform-token"
                  label={t('settings.platforms.telegramToken')}
                  value={form.token}
                  onChange={(value) => setForm({ ...form, token: value })}
                  placeholder={
                    editing?.config.tokenSet ? t('settings.platforms.secretKeep') : '123456:ABC-DEF…'
                  }
                  secret
                />
                <Field
                  testId="platform-base-url"
                  label={t('settings.platforms.telegramBaseUrl')}
                  value={form.baseUrl}
                  onChange={(value) => setForm({ ...form, baseUrl: value })}
                  placeholder="https://api.telegram.org"
                />
                <Field
                  testId="platform-test-chat"
                  label={t('settings.platforms.testChatId')}
                  value={form.testChatId}
                  onChange={(value) => setForm({ ...form, testChatId: value })}
                  placeholder={t('settings.platforms.testChatPlaceholder')}
                />
              </>
            )}
            {kind === 'onebot' && (
              <>
                <Field
                  testId="platform-onebot-url"
                  label={t('settings.platforms.onebotUrl')}
                  value={form.url}
                  onChange={(value) => setForm({ ...form, url: value })}
                  placeholder="ws://127.0.0.1:3001"
                />
                <Field
                  testId="platform-onebot-token"
                  label={t('settings.platforms.onebotToken')}
                  value={form.accessToken}
                  onChange={(value) => setForm({ ...form, accessToken: value })}
                  placeholder={
                    editing?.config.accessTokenSet ? t('settings.platforms.secretKeep') : t('settings.platforms.optional')
                  }
                  secret
                />
                <Field
                  testId="platform-test-chat"
                  label={t('settings.platforms.testChatId')}
                  value={form.testChatId}
                  onChange={(value) => setForm({ ...form, testChatId: value })}
                  placeholder={t('settings.platforms.onebotTestChatPlaceholder')}
                />
              </>
            )}
            {kind === 'webhook' && (
              <>
                <Field
                  testId="platform-outbound-url"
                  label={t('settings.platforms.outboundUrl')}
                  value={form.outboundUrl}
                  onChange={(value) => setForm({ ...form, outboundUrl: value })}
                  placeholder="https://example.com/amadeus/reply"
                />
                <Field
                  testId="platform-secret"
                  label={t('settings.platforms.secret')}
                  value={form.secret}
                  onChange={(value) => setForm({ ...form, secret: value })}
                  placeholder={
                    editing?.config.secretSet ? t('settings.platforms.secretKeep') : t('settings.platforms.optional')
                  }
                  secret
                />
              </>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy !== null}>
              {t('common.cancel')}
            </Button>
            <Button data-testid="platform-save" disabled={busy !== null || !canSave} onClick={() => void save()}>
              {busy !== null && <LoaderCircle className="size-3.5 animate-spin" />}
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Field({
  testId,
  label,
  value,
  onChange,
  placeholder,
  secret = false
}: {
  testId: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="text-[12.5px]">{label}</Label>
      <Input
        data-testid={testId}
        type={secret ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
