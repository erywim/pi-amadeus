import * as React from 'react'
import { useEffect, useState } from 'react'
import { LoaderCircle, Pencil, PlugZap, Plus, Radio, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { THINKING_LEVELS, type ProviderItem, type ThinkingLevel } from '@pi-amadeus/shared'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { useProviderStore } from '@renderer/stores/providerStore'

interface FormState {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  proxy: string
  tags: string[]
  dailyTokenQuota: number
  thinkingLevel: ThinkingLevel
  contextWindow: number
  maxTokens: number
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  proxy: '',
  tags: ['chat'],
  dailyTokenQuota: 0,
  thinkingLevel: 'off',
  contextWindow: 0,
  maxTokens: 0,
  enabled: true
}

/**
 * 多模型服务（参考常见的多模型服务）：列表 + 添加/编辑/删除 + 激活 + 真实连通性测试。
 * 激活的服务优先于下面的内置单项配置；密钥保存后不回显。
 */
export function ProviderSection(): React.JSX.Element {
  const { t } = useTranslation()
  const providers = useProviderStore((s) => s.providers)
  const loaded = useProviderStore((s) => s.loaded)
  const load = useProviderStore((s) => s.load)
  const create = useProviderStore((s) => s.create)
  const update = useProviderStore((s) => s.update)
  const remove = useProviderStore((s) => s.remove)
  const activate = useProviderStore((s) => s.activate)
  const test = useProviderStore((s) => s.test)

  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; provider: ProviderItem } | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  function openCreate(): void {
    setForm(EMPTY_FORM)
    setDialog({ mode: 'create' })
  }

  function openEdit(provider: ProviderItem): void {
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      model: provider.model,
      proxy: provider.proxy,
      tags: provider.tags.length > 0 ? provider.tags : ['chat'],
      dailyTokenQuota: provider.dailyTokenQuota,
      thinkingLevel: provider.thinkingLevel,
      contextWindow: provider.contextWindow,
      maxTokens: provider.maxTokens,
      enabled: provider.enabled
    })
    setDialog({ mode: 'edit', provider })
  }

  async function save(): Promise<void> {
    if (!dialog) return
    setBusy('save')
    try {
      const input = {
        name: form.name,
        baseUrl: form.baseUrl,
        model: form.model,
        proxy: form.proxy,
        tags: form.tags,
        dailyTokenQuota: form.dailyTokenQuota,
        thinkingLevel: form.thinkingLevel,
        contextWindow: form.contextWindow,
        maxTokens: form.maxTokens,
        enabled: form.enabled,
        ...(form.apiKey ? { apiKey: form.apiKey } : {})
      }
      if (dialog.mode === 'create') await create(input)
      else await update(dialog.provider.id, input)
      toast.success(t('settings.providers.saved'))
      setDialog(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function handleTest(provider: ProviderItem): Promise<void> {
    setTesting(provider.id)
    try {
      const result = await test(provider.id)
      if (result.ok) {
        toast.success(
          t('settings.providers.testOk', {
            latency: result.latencyMs ?? 0,
            reply: result.reply || 'OK'
          })
        )
      } else {
        toast.error(result.error ?? t('settings.providers.testFailed'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(null)
    }
  }

  async function handleDelete(provider: ProviderItem): Promise<void> {
    if (confirmDelete !== provider.id) {
      setConfirmDelete(provider.id)
      window.setTimeout(
        () => setConfirmDelete((current) => (current === provider.id ? null : current)),
        3000
      )
      return
    }
    setBusy(provider.id)
    try {
      await remove(provider.id)
      setConfirmDelete(null)
      toast.success(t('settings.providers.deleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mb-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold">{t('settings.providers.title')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('settings.providers.desc')}
          </p>
        </div>
        <Button data-testid="provider-add" variant="outline" size="sm" onClick={openCreate}>
          <Plus className="size-3.5" />
          {t('settings.providers.add')}
        </Button>
      </div>

      <div className="mt-3 grid gap-2">
        {loaded && providers.length === 0 && (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {t('settings.providers.empty')}
          </p>
        )}
        {providers.map((provider) => (
          <div
            key={provider.id}
            data-testid="provider-row"
            data-provider-id={provider.id}
            className="rounded-md border border-border bg-card px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="provider-activate"
                title={provider.active ? t('settings.providers.active') : t('settings.providers.activate')}
                aria-label={provider.active ? t('settings.providers.active') : t('settings.providers.activate')}
                disabled={provider.active || busy !== null}
                onClick={() => {
                  setBusy(provider.id)
                  void activate(provider.id)
                    .then(() => toast.success(t('settings.providers.activated')))
                    .catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error))
                    )
                    .finally(() => setBusy(null))
                }}
                className={provider.active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}
              >
                <Radio className="size-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <b className="truncate text-[13.5px] font-semibold">{provider.name}</b>
                  {provider.active && (
                    <Badge variant="outline" className="border-primary/40 px-1.5 py-0 text-[10px] text-primary">
                      {t('settings.providers.active')}
                    </Badge>
                  )}
                  {!provider.enabled && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                      {t('settings.providers.disabled')}
                    </Badge>
                  )}
                  {!provider.apiKeySet && (
                    <Badge variant="outline" className="border-destructive/40 px-1.5 py-0 text-[10px] text-destructive">
                      {t('settings.providers.noKey')}
                    </Badge>
                  )}
                  {provider.coolingDown && (
                    <Badge
                      data-testid="provider-cooling"
                      variant="outline"
                      className="border-destructive/40 px-1.5 py-0 text-[10px] text-destructive"
                    >
                      {t('settings.providers.coolingDown')}
                    </Badge>
                  )}
                </div>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {provider.baseUrl} · {provider.model}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {provider.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="px-1.5 py-0 text-[9.5px] text-muted-foreground"
                    >
                      {t(`settings.providers.tag.${tag}`)}
                    </Badge>
                  ))}
                  {provider.dailyTokenQuota > 0 && (
                    <span
                      data-testid="provider-quota"
                      className={
                        provider.quotaExceeded
                          ? 'font-mono text-[10px] text-destructive'
                          : 'font-mono text-[10px] text-muted-foreground'
                      }
                    >
                      {t('settings.providers.quotaUsed', {
                        used: provider.todayTokens,
                        quota: provider.dailyTokenQuota
                      })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="provider-test"
                  disabled={testing === provider.id}
                  onClick={() => void handleTest(provider)}
                >
                  {testing === provider.id ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="size-3.5" />
                  )}
                  {t('settings.providers.test')}
                </Button>
                <Button data-testid="provider-edit" variant="ghost" size="sm" onClick={() => openEdit(provider)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  data-testid="provider-delete"
                  variant={confirmDelete === provider.id ? 'destructive' : 'ghost'}
                  size="sm"
                  disabled={busy === provider.id}
                  onClick={() => void handleDelete(provider)}
                >
                  <Trash2 className="size-3.5" />
                  {confirmDelete === provider.id && t('settings.providers.confirmDelete')}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
        <DialogContent className="max-w-lg rounded-xl">
          <DialogHeader>
            <DialogTitle className="text-[17px]">
              {dialog?.mode === 'edit' ? t('settings.providers.editTitle') : t('settings.providers.addTitle')}
            </DialogTitle>
            <DialogDescription className="text-[12.5px]">
              {t('settings.providers.dialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field testId="provider-name" label={t('settings.providers.name')} value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="DeepSeek" />
            <Field
              testId="provider-base-url"
              label={t('settings.providers.baseUrl')}
              value={form.baseUrl}
              onChange={(v) => setForm({ ...form, baseUrl: v })}
              placeholder="https://api.deepseek.com/v1"
            />
            <Field
              testId="provider-api-key"
              label={t('settings.providers.apiKey')}
              value={form.apiKey}
              onChange={(v) => setForm({ ...form, apiKey: v })}
              placeholder={dialog?.mode === 'edit' ? t('settings.providers.keyKeep') : 'sk-…'}
              secret
            />
            <Field
              testId="provider-model"
              label={t('settings.providers.model')}
              value={form.model}
              onChange={(v) => setForm({ ...form, model: v })}
              placeholder="deepseek-v4-pro"
            />
            <Field
              testId="provider-proxy"
              label={t('settings.providers.proxy')}
              value={form.proxy}
              onChange={(v) => setForm({ ...form, proxy: v })}
              placeholder="http://127.0.0.1:7890"
            />
            <div className="grid gap-1.5">
              <Label className="text-[12.5px]">{t('settings.providers.tags')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {(['chat', 'vision', 'summary', 'memory'] as const).map((tag) => {
                  const selected = form.tags.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      data-testid={`provider-tag-${tag}`}
                      onClick={() =>
                        setForm({
                          ...form,
                          tags: selected
                            ? form.tags.filter((item) => item !== tag)
                            : [...form.tags, tag]
                        })
                      }
                      className={
                        selected
                          ? 'rounded-full border border-primary/40 bg-accent-soft px-2 py-0.5 text-[11px] text-foreground'
                          : 'rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-surface-soft'
                      }
                    >
                      {t(`settings.providers.tag.${tag}`)}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('settings.providers.tagsHint')}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[12.5px]">{t('settings.providers.dailyQuota')}</Label>
              <Input
                data-testid="provider-quota-input"
                type="number"
                min={0}
                value={form.dailyTokenQuota}
                onChange={(e) =>
                  setForm({ ...form, dailyTokenQuota: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[12.5px]">{t('settings.ai.thinkingLevel')}</Label>
              <Select
                value={form.thinkingLevel}
                onValueChange={(v) => setForm({ ...form, thinkingLevel: v as ThinkingLevel })}
              >
                <SelectTrigger data-testid="provider-thinking-level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {t(`settings.ai.thinking.${level}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-[12.5px]">{t('settings.ai.contextWindow')}</Label>
                <Input
                  data-testid="provider-context-window"
                  type="number"
                  min={0}
                  value={form.contextWindow}
                  onChange={(e) =>
                    setForm({ ...form, contextWindow: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-[12.5px]">{t('settings.ai.maxTokens')}</Label>
                <Input
                  data-testid="provider-max-tokens"
                  type="number"
                  min={0}
                  value={form.maxTokens}
                  onChange={(e) =>
                    setForm({ ...form, maxTokens: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
            </div>
            <p className="-mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t('settings.ai.modelRuntimeHint')}
            </p>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <Switch checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: checked })} />
              {t('settings.providers.enabled')}
            </label>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy !== null}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="provider-save"
              disabled={busy !== null || !form.name.trim() || !form.baseUrl.trim() || !form.model.trim()}
              onClick={() => void save()}
            >
              {busy !== null && <LoaderCircle className="size-3.5 animate-spin" />}
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
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
