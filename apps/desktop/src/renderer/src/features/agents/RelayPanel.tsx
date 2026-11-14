import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Eye, EyeOff, Link2, LoaderCircle, PlugZap, Radio, RefreshCw, ShieldCheck, Unplug, WifiOff } from 'lucide-react'
import toast from 'react-hot-toast'
import type { RelayStatus } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { AgentApiError, disableRelay, enableRelay, fetchRelayStatus, reconnectRelay, type RelayEnableInput } from '@renderer/lib/agentApi'
import { cn } from '@renderer/lib/utils'
import { useAgentText } from './translations'

const POLL_MS = 5000
const CONNECT_CODE = /^[A-Za-z0-9_-]{16,128}$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const MAX_REGISTRATION_KEY = 4096
const MAX_DEVICE_NAME = 80

interface RelayForm {
  serverUrl: string
  connectCode: string
  registrationKey: string
  e2eEncryption: boolean
  deviceName: string
}

type RelayFormErrors = Partial<Record<keyof RelayForm, string>>

const emptyForm: RelayForm = { serverUrl: '', connectCode: '', registrationKey: '', e2eEncryption: true, deviceName: '' }

/** 控制字符会污染日志与协议字段；逐字符检查，避免正则里的控制字符类。 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** 与 Brain 的归一化保持一致：https/wss 任意主机；明文 http/ws 只允许本机回环。 */
function validRelayUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (!['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol)) return false
  // 账号密码、查询串和片段都不属于 Relay 地址，避免凭据藏在 URL 里。
  if (url.username || url.password || url.search || url.hash) return false
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && !LOOPBACK_HOSTS.has(url.hostname)) return false
  return true
}

function relayErrorMessage(reason: unknown, unavailable: string): string {
  if (reason instanceof AgentApiError && reason.status === 404) return unavailable
  return reason instanceof Error ? reason.message : String(reason)
}

/** Relay 控制面板：只投影 Brain 的公开状态，连接码与注册密钥不离开当前窗口内存。 */
export function RelayPanel({ userId }: { userId: string }): React.JSX.Element {
  const text = useAgentText()
  const [status, setStatus] = useState<RelayStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<RelayForm>(emptyForm)
  const [errors, setErrors] = useState<RelayFormErrors>({})
  const [revealSecrets, setRevealSecrets] = useState(false)
  const mounted = useRef(true)
  const actionInFlight = useRef(false)
  const readInFlight = useRef<Promise<void> | null>(null)
  const initialized = useRef(false)

  const load = useCallback((): Promise<void> => {
    if (readInFlight.current) return readInFlight.current
    const promise = fetchRelayStatus().then((next) => {
      if (!mounted.current) return
      setStatus(next)
      setError(null)
    }).catch((reason: unknown) => {
      if (mounted.current) setError(relayErrorMessage(reason, text('relayUnavailable')))
    }).finally(() => {
      readInFlight.current = null
      if (mounted.current) setLoading(false)
    })
    readInFlight.current = promise
    return promise
  }, [text])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])

  useEffect(() => {
    // 连接状态由 Brain 驱动；只在页面可见且没有操作在途时轮询。
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || actionInFlight.current) return
      void load()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!status || initialized.current) return
    initialized.current = true
    // 地址/连接码留空表示沿用服务端环境变量；状态接口永远不返回连接码/注册密钥。
    setForm({
      serverUrl: '',
      connectCode: '',
      registrationKey: '',
      e2eEncryption: status.e2eEncryption !== false,
      deviceName: status.deviceName ?? ''
    })
  }, [status])

  const update = (key: keyof RelayForm, value: string | boolean): void => {
    setForm((previous) => ({ ...previous, [key]: value }))
    setErrors((previous) => {
      if (!previous[key]) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  async function act(operation: () => Promise<void>): Promise<void> {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (reason) {
      const message = relayErrorMessage(reason, text('relayUnavailable'))
      if (mounted.current) {
        setError(message)
        toast.error(message)
      }
    } finally {
      actionInFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function validate(): RelayFormErrors {
    const next: RelayFormErrors = {}
    const serverUrl = form.serverUrl.trim()
    const connectCode = form.connectCode.trim()
    const registrationKey = form.registrationKey.trim()
    const deviceName = form.deviceName.trim()
    const configured = status?.configured === true
    // 服务端已有完整配置时表单全部可留空；留空字段沿用环境变量，填写才覆盖。
    if (!serverUrl) {
      if (!configured) next.serverUrl = text('relayServerUrlRequired')
    } else if (!validRelayUrl(serverUrl)) {
      next.serverUrl = text('relayInvalidUrl')
    }
    if (!connectCode) {
      if (!configured) next.connectCode = text('relayConnectCodeRequired')
    } else if (!CONNECT_CODE.test(connectCode)) {
      next.connectCode = text('relayInvalidCode')
    }
    if (registrationKey.length > MAX_REGISTRATION_KEY || hasControlCharacters(registrationKey)) {
      next.registrationKey = text('relayInvalidKey')
    }
    if (deviceName.length > MAX_DEVICE_NAME || hasControlCharacters(deviceName)) {
      next.deviceName = text('relayInvalidName')
    }
    return next
  }

  function onEnable(): void {
    const nextErrors = validate()
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    void act(async () => {
      const input: RelayEnableInput = {
        ...(form.serverUrl.trim() ? { serverUrl: form.serverUrl.trim() } : {}),
        ...(form.connectCode.trim() ? { connectCode: form.connectCode.trim() } : {}),
        ...(form.registrationKey.trim() ? { registrationKey: form.registrationKey.trim() } : {}),
        ...(form.deviceName.trim() ? { deviceName: form.deviceName.trim() } : {}),
        e2eEncryption: form.e2eEncryption,
        userId
      }
      const next = await enableRelay(input)
      if (!mounted.current) return
      setStatus(next)
      // 秘密只活在当前窗口内存；启用成功后立刻清空输入框。
      setForm((previous) => ({ ...previous, connectCode: '', registrationKey: '' }))
      setErrors({})
      setRevealSecrets(false)
      toast.success(text('relayEnabledToast'))
      await load()
    })
  }

  function onDisable(): void {
    void act(async () => {
      await disableRelay()
      if (!mounted.current) return
      setRevealSecrets(false)
      toast.success(text('relayDisabledToast'))
      await load()
    })
  }

  function onReconnect(): void {
    void act(async () => {
      const next = await reconnectRelay()
      if (!mounted.current) return
      setStatus(next)
      toast.success(text('relayReconnectedToast'))
      await load()
    })
  }

  const formatDate = (timestamp: number): string => new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(timestamp)
  const configured = status?.configured === true
  const state = status?.state ?? 'stopped'
  const stateIcon = state === 'connected'
    ? <Radio aria-hidden="true" className="size-4 text-mint" />
    : state === 'connecting'
      ? <LoaderCircle aria-hidden="true" className="size-4 text-primary motion-safe:animate-spin" />
      : state === 'error' || state === 'replaced'
        ? <AlertTriangle aria-hidden="true" className="size-4 text-destructive" />
        : <WifiOff aria-hidden="true" className="size-4 text-muted-foreground" />

  return <section data-testid="agent-relay" className="mx-auto w-full max-w-4xl border-t border-border px-4 py-6 sm:px-7">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
      <div><p className="mb-2 font-mono text-[10px] tracking-[0.16em] text-primary">RELAY / WAN</p><h2 className="text-lg font-semibold">{text('relayTitle')}</h2><p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">{text('relayDescription')}</p></div>
      <Button type="button" variant="outline" size="sm" data-testid="agent-relay-refresh" disabled={busy || loading} onClick={() => void load()}><RefreshCw className={cn(loading && 'motion-safe:animate-spin')} aria-hidden="true" />{text('refresh')}</Button>
    </div>
    <p className="my-5 flex items-start gap-2 rounded-lg border border-primary/15 bg-accent-soft/60 p-3 text-xs leading-relaxed text-ink-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />{text('relaySecretHint')}</p>
    {error && <div role="alert" data-testid="agent-relay-error" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"><p>{error}</p><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{text('retry')}</Button></div>}
    {loading && !status ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">{text('relayLoading')}</p> : status && <>
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <h3 className="flex items-center gap-2 text-sm font-medium" data-testid="agent-relay-state" data-state={state} data-enabled={status.enabled} data-configured={configured}>{stateIcon}{text(status.enabled ? 'relayEnabledState' : 'relayDisabledState')}</h3>
        {status.enabled && <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" data-testid="agent-relay-reconnect" disabled={busy} onClick={onReconnect}><PlugZap aria-hidden="true" />{text('relayReconnect')}</Button>
          <Button type="button" variant="outline" size="sm" data-testid="agent-relay-disable" disabled={busy} onClick={onDisable}><Unplug aria-hidden="true" />{text('relayDisable')}</Button>
        </div>}
      </div>
      <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-border bg-surface-soft/40 p-4 text-xs sm:grid-cols-2">
        <div><dt className="text-[10px] font-medium text-muted-foreground">{text('relayStateLabel')}</dt><dd className="mt-1 font-mono text-ink-2" data-testid="agent-relay-connection-state">{text(`relayState.${state}`)}</dd></div>
        <div><dt className="text-[10px] font-medium text-muted-foreground">{text('relayConfiguredLabel')}</dt><dd className={cn('mt-1 font-mono', configured ? 'text-mint' : 'text-muted-foreground')} data-testid="agent-relay-configured">{text(configured ? 'relayConfigured' : 'relayNotConfigured')}</dd></div>
        <div><dt className="text-[10px] font-medium text-muted-foreground">{text('relayServerUrl')}</dt><dd className="mt-1 select-all break-all font-mono text-ink-2" data-testid="agent-relay-server-url">{status.serverUrl || text('none')}</dd></div>
        <div><dt className="text-[10px] font-medium text-muted-foreground">{text('relayE2e')}</dt><dd className="mt-1 font-mono text-ink-2">{text(status.e2eEncryption !== false ? 'relayOn' : 'relayOff')}</dd></div>
        <div><dt className="text-[10px] font-medium text-muted-foreground">{text('relayDeviceName')}</dt><dd className="mt-1 break-all font-mono text-ink-2">{status.deviceName || text('none')}</dd></div>
        <div><dt className="text-[10px] font-medium text-muted-foreground">{text('relayActiveTunnels')}</dt><dd className="mt-1 font-mono text-ink-2" data-testid="agent-relay-tunnels">{status.activeTunnels}</dd></div>
        {status.connectedAt ? <div><dt className="text-[10px] font-medium text-muted-foreground">{text('relayConnectedAt')}</dt><dd className="mt-1 font-mono text-ink-2">{formatDate(status.connectedAt)}</dd></div> : null}
        {status.lastError ? <div className="sm:col-span-2" data-testid="agent-relay-last-error"><dt className="text-[10px] font-medium text-muted-foreground">{text('relayLastError')}</dt><dd className="mt-1 break-words text-destructive">{status.lastError}</dd></div> : null}
      </dl>
      {!status.enabled && <form data-testid="agent-relay-form" className="mt-5 grid gap-4 border-t border-border pt-5" onSubmit={(event) => { event.preventDefault(); onEnable() }}>
        <div>
          <p className="text-xs leading-relaxed text-muted-foreground">{text(configured ? 'relayConfiguredHelp' : 'relayEnvHint')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="agent-relay-server-url-input" className="text-xs">{text('relayServerUrl')}</Label>
            <Input id="agent-relay-server-url-input" data-testid="agent-relay-server-url-input" className="mt-1.5 font-mono text-xs" value={form.serverUrl} onChange={(event) => update('serverUrl', event.target.value)} placeholder="https://relay.example.com" autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.serverUrl)} aria-describedby={errors.serverUrl ? 'agent-relay-server-url-error' : undefined} />
            {errors.serverUrl && <p id="agent-relay-server-url-error" className="mt-1 text-[10px] leading-relaxed text-destructive">{errors.serverUrl}</p>}
          </div>
          <div>
            <Label htmlFor="agent-relay-device-name-input" className="text-xs">{text('relayDeviceName')}</Label>
            <Input id="agent-relay-device-name-input" data-testid="agent-relay-device-name-input" className="mt-1.5 text-xs" value={form.deviceName} onChange={(event) => update('deviceName', event.target.value)} placeholder="pi-amadeus" maxLength={MAX_DEVICE_NAME} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.deviceName)} aria-describedby={errors.deviceName ? 'agent-relay-device-name-error' : undefined} />
            {errors.deviceName && <p id="agent-relay-device-name-error" className="mt-1 text-[10px] leading-relaxed text-destructive">{errors.deviceName}</p>}
          </div>
          <div>
            <Label htmlFor="agent-relay-code-input" className="text-xs">{text('relayConnectCode')}</Label>
            <div className="relative mt-1.5">
              <Input id="agent-relay-code-input" data-testid="agent-relay-code-input" type={revealSecrets ? 'text' : 'password'} className="pr-9 font-mono text-xs" value={form.connectCode} onChange={(event) => update('connectCode', event.target.value)} maxLength={128} autoComplete="new-password" spellCheck={false} aria-invalid={Boolean(errors.connectCode)} aria-describedby={errors.connectCode ? 'agent-relay-code-error' : 'agent-relay-code-hint'} />
              <Button type="button" variant="ghost" size="sm" className="absolute right-0 top-0 size-9 p-0 text-muted-foreground" aria-label={text(revealSecrets ? 'hideSecret' : 'showSecret')} aria-pressed={revealSecrets} onClick={() => setRevealSecrets((value) => !value)}>{revealSecrets ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button>
            </div>
            {errors.connectCode ? <p id="agent-relay-code-error" className="mt-1 text-[10px] leading-relaxed text-destructive">{errors.connectCode}</p> : <p id="agent-relay-code-hint" className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{text('relayConnectCodeHint')}</p>}
          </div>
          <div>
            <Label htmlFor="agent-relay-key-input" className="text-xs">{text('relayRegistrationKey')}</Label>
            <Input id="agent-relay-key-input" data-testid="agent-relay-key-input" type={revealSecrets ? 'text' : 'password'} className="mt-1.5 font-mono text-xs" value={form.registrationKey} onChange={(event) => update('registrationKey', event.target.value)} maxLength={MAX_REGISTRATION_KEY} autoComplete="new-password" spellCheck={false} aria-invalid={Boolean(errors.registrationKey)} aria-describedby={errors.registrationKey ? 'agent-relay-key-error' : undefined} />
            {errors.registrationKey && <p id="agent-relay-key-error" className="mt-1 text-[10px] leading-relaxed text-destructive">{errors.registrationKey}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-soft/40 p-3">
          <div className="min-w-0"><p className="text-xs font-medium">{text('relayE2e')}</p><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{text('relayE2eHint')}</p></div>
          <Switch data-testid="agent-relay-e2e" aria-label={text('relayE2e')} checked={form.e2eEncryption} onCheckedChange={(checked) => update('e2eEncryption', checked)} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-[10px] leading-relaxed text-muted-foreground">{text('relayEnableHint')}</p>
          <Button type="submit" data-testid="agent-relay-enable" disabled={busy}>{busy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}{text('relayEnable')}</Button>
        </div>
      </form>}
    </>}
  </section>
}
