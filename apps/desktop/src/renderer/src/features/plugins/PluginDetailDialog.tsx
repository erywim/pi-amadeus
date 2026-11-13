import * as React from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, RotateCw, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { CatalogEntry, InstalledPlugin, PluginField } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { usePluginStore } from '@renderer/stores/pluginStore'

export function PluginDetailDialog({
  entry,
  installed,
  activeTheme,
  onClose
}: {
  entry: CatalogEntry | null
  installed?: InstalledPlugin
  activeTheme: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const busyId = usePluginStore((s) => s.busyId)
  const install = usePluginStore((s) => s.install)
  const uninstall = usePluginStore((s) => s.uninstall)
  const setEnabled = usePluginStore((s) => s.setEnabled)
  const reconnect = usePluginStore((s) => s.reconnect)
  const applyTheme = usePluginStore((s) => s.applyTheme)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [confirmRemove, setConfirmRemove] = useState(false)

  // 换一个插件就清空上一次的输入与二次确认态，避免把 A 的目录/Token 装进 B
  useEffect(() => {
    setFields({})
    setConfirmRemove(false)
  }, [entry?.id])

  if (!entry) return <></>
  const busy = busyId === entry.id
  const presetFields: PluginField[] = entry.mcp?.fields ?? []
  const accent = entry.accent ?? 'var(--primary)'

  async function handleInstall(): Promise<void> {
    try {
      await install(entry!.id, fields)
      toast.success(t('plugins.installDone'))
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleUninstall(): Promise<void> {
    if (!confirmRemove) {
      setConfirmRemove(true)
      return
    }
    try {
      await uninstall(entry!.id)
      toast.success(t('plugins.removeDone'))
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const missingRequired = presetFields.some(
    (field) => field.required && !(fields[field.key] ?? field.default ?? '').trim()
  )

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent data-testid="plugin-detail" className="max-h-[85vh] max-w-xl overflow-y-auto rounded-xl">
        <DialogHeader>
          <div className="flex items-start gap-3 pr-6">
            <span
              className="grid size-11 shrink-0 place-items-center rounded-[12px] text-[22px]"
              style={{
                background: `linear-gradient(135deg, ${accent}26, ${accent}0a)`,
                border: `1px solid ${accent}33`
              }}
            >
              {entry.icon}
            </span>
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-[17px]">
                {entry.name}
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                  {t(`plugins.kind.${entry.kind}`)}
                </Badge>
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12.5px]">
                {entry.author} · v{entry.version} · {entry.category}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <p className="whitespace-pre-line text-[13px] leading-relaxed text-ink-2">
          {entry.details || entry.description}
        </p>

        {entry.homepage && (
          <a
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault()
              window.open(entry.homepage!, '_blank')
            }}
            className="inline-flex w-fit items-center gap-1 text-[12.5px] text-primary underline underline-offset-4"
          >
            <ExternalLink className="size-3" />
            {t('plugins.homepage')}
          </a>
        )}

        {!installed && presetFields.length > 0 && (
          <div className="grid gap-3 rounded-lg border border-border bg-surface-soft p-3">
            {presetFields.map((field) => (
              <div key={field.key} className="grid gap-1.5">
                <Label htmlFor={`plugin-field-${field.key}`} className="text-[12.5px]">
                  {field.label}
                  {field.required && <span className="ml-0.5 text-destructive">*</span>}
                </Label>
                <Input
                  id={`plugin-field-${field.key}`}
                  type={field.secret ? 'password' : 'text'}
                  value={fields[field.key] ?? ''}
                  placeholder={field.default || field.hint || ''}
                  onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
                {field.hint && <p className="text-[11px] text-muted-foreground">{field.hint}</p>}
              </div>
            ))}
          </div>
        )}

        {installed && entry.kind === 'mcp' && (
          <div className="grid gap-2 rounded-lg border border-border bg-surface-soft p-3 text-[12px]">
            <McpDetail plugin={installed} />
            <Button
              variant="outline"
              size="sm"
              className="mt-1 w-fit"
              disabled={busy}
              onClick={() => {
                void reconnect(entry.id).catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
                )
              }}
            >
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
              {t('plugins.mcp.reconnect')}
            </Button>
          </div>
        )}

        {installed && entry.kind === 'skill' && typeof installed.config.dir === 'string' && (
          <p className="break-all rounded-md border border-border bg-surface-soft px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
            {installed.config.dir}
          </p>
        )}

        {installed && entry.kind === 'prompt' && typeof installed.config.prompt === 'string' && (
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-black/80 p-3 font-mono text-[11.5px] leading-relaxed text-terminal-green">
            {installed.config.prompt}
          </pre>
        )}

        <div className="flex items-center gap-2 border-t border-border pt-3">
          {!installed ? (
            <Button data-testid="plugin-install" disabled={busy || missingRequired} onClick={() => void handleInstall()}>
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {t('plugins.install')}
            </Button>
          ) : (
            <>
              <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                <Switch
                  data-testid="plugin-enabled"
                  checked={installed.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    void setEnabled(entry.id, checked).catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error))
                    )
                  }}
                />
                {installed.enabled ? t('plugins.enabled') : t('plugins.disabled')}
              </label>
              {installed.kind === 'theme' && (
                <Button
                  variant={activeTheme ? 'secondary' : 'outline'}
                  size="sm"
                  disabled={!installed.enabled}
                  onClick={() => applyTheme(activeTheme ? null : entry.id)}
                >
                  {activeTheme ? t('plugins.themeInUse') : t('plugins.applyTheme')}
                </Button>
              )}
              <span className="flex-1" />
              <Button
                data-testid="plugin-remove"
                variant={confirmRemove ? 'destructive' : 'ghost'}
                size="sm"
                disabled={busy}
                onClick={() => void handleUninstall()}
                onBlur={() => setConfirmRemove(false)}
              >
                <Trash2 className="size-3.5" />
                {confirmRemove ? t('plugins.confirmRemove') : t('plugins.remove')}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** MCP 配置摘要：命令可见、环境变量值打码（令牌不二次回显） */
function McpDetail({ plugin }: { plugin: InstalledPlugin }): React.JSX.Element {
  const { t } = useTranslation()
  const command = typeof plugin.config.command === 'string' ? plugin.config.command : ''
  const args = Array.isArray(plugin.config.args)
    ? plugin.config.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  const env =
    plugin.config.env && typeof plugin.config.env === 'object' && !Array.isArray(plugin.config.env)
      ? Object.keys(plugin.config.env as Record<string, unknown>)
      : []
  return (
    <>
      <p className="break-all font-mono text-[11.5px] text-ink-2">
        {[command, ...args].join(' ') || '—'}
      </p>
      {env.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          {t('plugins.mcp.envKeys', { keys: env.join(', ') })}
        </p>
      )}
      {plugin.status?.state === 'error' && plugin.status.error && (
        <p className="break-words text-[11.5px] text-destructive">{plugin.status.error}</p>
      )}
      {plugin.status?.state === 'connected' && (
        <p className="break-words text-[11.5px] text-muted-foreground">
          {t('plugins.mcp.tools', { tools: plugin.status.tools.join(', ') || '—' })}
        </p>
      )}
    </>
  )
}
