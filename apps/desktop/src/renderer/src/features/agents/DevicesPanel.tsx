import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Laptop, Link, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react'
import toast from 'react-hot-toast'
import type { CollaborationDevice, CollaborationPairing, CollaborationStatus } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { createCollaborationPairing, fetchCollaborationStatus, revokeCollaborationDevice, setCollaborationEnabled } from '@renderer/lib/agentApi'
import { useAgentText } from './translations'

export function DevicesPanel({ userId }: { userId: string }): React.JSX.Element {
  const text = useAgentText()
  const [status, setStatus] = useState<CollaborationStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'enable' | CollaborationDevice | null>(null)
  const [role, setRole] = useState<CollaborationPairing['role']>('observer')
  const [pairing, setPairing] = useState<CollaborationPairing | null>(null)
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(true)
  const actionInFlight = useRef(false)
  const readInFlight = useRef<Promise<void> | null>(null)

  const load = useCallback((): Promise<void> => {
    if (readInFlight.current) return readInFlight.current
    const promise = fetchCollaborationStatus(userId).then((next) => {
      if (!mounted.current) return
      setStatus(next)
      setError(null)
      if (!next.enabled) setPairing(null)
    }).catch((reason: unknown) => {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      readInFlight.current = null
      if (mounted.current) setLoading(false)
    })
    readInFlight.current = promise
    return promise
  }, [userId])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])

  useEffect(() => {
    if (!status?.enabled) return
    // 开启后只轮询观察设备状态；进入设备页永远不会自动开启监听端口。
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 8000)
    return () => window.clearInterval(timer)
  }, [status?.enabled, load])

  useEffect(() => {
    if (!pairing) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing])

  async function act(operation: () => Promise<void>): Promise<void> {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(true)
    setError(null)
    try { await operation() } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (mounted.current) setError(message)
      toast.error(message)
    } finally {
      actionInFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const formatDate = (timestamp: number): string => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp)
  const devices = status?.devices.filter((device) => !device.revokedAt) ?? []

  return <section data-testid="agent-devices" className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-7">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
      <div><p className="mb-2 font-mono text-[10px] tracking-[0.16em] text-primary">LAN / 3003</p><h2 className="text-lg font-semibold">{text('devices')}</h2><p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">{text('devicesDescription')}</p></div>
      <Button type="button" variant="outline" size="sm" data-testid="agent-devices-refresh" disabled={busy || loading} onClick={() => void load()}><RefreshCw aria-hidden="true" />{text('refresh')}</Button>
    </div>
    <p className="my-5 flex items-start gap-2 rounded-lg border border-amber-700/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-ink-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />{text('networkWarning')}</p>
    {error && <div role="alert" data-testid="agent-devices-error" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"><p>{error}</p><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{text('retry')}</Button></div>}
    {loading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">{text('devicesLoading')}</p> : status && <>
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <h3 className="flex items-center gap-2 text-sm font-medium" data-testid="agent-devices-state" data-enabled={status.enabled}>{status.enabled ? <ShieldCheck className="size-4 text-mint" aria-hidden="true" /> : <WifiOff className="size-4 text-muted-foreground" aria-hidden="true" />}{text(status.enabled ? 'serviceEnabled' : 'serviceDisabled')}</h3>
        <Button type="button" data-testid={status.enabled ? 'agent-devices-disable' : 'agent-devices-enable'} variant={status.enabled ? 'outline' : 'default'} disabled={busy} onClick={() => {
          if (!status.enabled) { setConfirm('enable'); return }
          void act(async () => {
            await setCollaborationEnabled(false)
            // 服务端已关闭后立即移除配对秘密，再读取权威状态。
            if (mounted.current) { setPairing(null); setStatus((previous) => previous ? { ...previous, enabled: false } : previous) }
            await load()
          })
        }}>{text(status.enabled ? 'disableDevices' : 'enableDevices')}</Button>
      </div>
      {status.enabled && <>
        <div className="grid gap-6 border-y border-border py-6 md:grid-cols-[1.1fr_1fr]">
          <div><h3 className="mb-3 text-xs font-semibold">{text('lanUrls')}</h3><div className="grid gap-2">{status.urls.length ? status.urls.map((url) => <p key={url} className="flex items-start gap-2 rounded-md bg-surface-soft p-3 font-mono text-xs text-ink-2" data-testid="agent-device-url"><Link aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span className="select-all break-all">{url}</span></p>) : <p className="text-xs text-muted-foreground">{text('noUrls')}</p>}</div></div>
          <div className="grid content-start gap-3">
            <Label htmlFor="agent-device-role">{text('role')}</Label>
            <select id="agent-device-role" data-testid="agent-device-role" value={role} className="h-9 w-full rounded-md border border-border bg-surface px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => {
              setRole(event.target.value as CollaborationPairing['role'])
              // 切角色清除旧展示，避免用户把观察者码误当成控制者码分享。
              setPairing(null)
            }}><option value="observer">{text('observer')}</option><option value="controller">{text('controller')}</option></select>
            <Button type="button" data-testid="agent-device-pair" variant="outline" disabled={busy} onClick={() => void act(async () => {
              const next = await createCollaborationPairing(userId, role)
              // 配对码只存在当前组件内存，不写日志、URL 或持久化 store。
              if (mounted.current) { setPairing(next); setNow(Date.now()) }
            })}>{text('pairing')}</Button>
            {pairing && <div className="rounded-lg border border-primary/20 bg-accent-soft p-4" data-testid="agent-device-pairing">
              {pairing.expiresAt <= now ? <p className="text-xs text-muted-foreground">{text('pairingExpired')}</p> : <><p className="text-[10px] font-medium text-ink-2">{text('pairingCode')}</p><p className="my-3 select-all break-all font-mono text-2xl font-semibold tracking-[0.18em] text-primary" data-testid="agent-device-code">{pairing.code}</p><p className="text-[10px] leading-relaxed text-muted-foreground">{text(pairing.role)}<br />{text('expires')} {formatDate(pairing.expiresAt)}</p></>}
            </div>}
          </div>
        </div>
      </>}
      <div className="mt-6">
        <h3 className="mb-3 text-xs font-semibold">{text('pairedDevices')}</h3>
        {devices.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">{text('noDevices')}</p> : <div className="divide-y divide-border">{devices.map((device) => <div key={device.id} data-testid="agent-device-row" data-device-id={device.id} className="flex flex-wrap items-center gap-3 py-4"><Laptop className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 flex-1"><h4 className="break-words text-sm font-medium">{device.name}</h4><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{text(device.role)} · {text(device.online ? 'online' : 'offline')}<br />{text('lastSeen')} {formatDate(device.lastSeenAt)}</p></div><Button type="button" data-testid="agent-device-revoke" variant="outline" size="sm" disabled={busy} onClick={() => setConfirm(device)}>{text('revoke')}</Button></div>)}</div>}
      </div>
    </>}
    <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open && !busy) setConfirm(null) }}><DialogContent className="w-[calc(100%-2rem)] rounded-xl motion-reduce:animate-none motion-reduce:transition-none"><DialogHeader><DialogTitle>{text(confirm === 'enable' ? 'enableDevices' : 'revoke')}</DialogTitle><DialogDescription>{text(confirm === 'enable' ? 'enableDescription' : 'revokeWarning')}</DialogDescription></DialogHeader><DialogFooter className="gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>{text('cancel')}</Button><Button type="button" data-testid="agent-device-confirm" variant={confirm === 'enable' ? 'default' : 'destructive'} disabled={busy} onClick={() => {
      const current = confirm
      if (!current) return
      void act(async () => {
        if (current === 'enable') await setCollaborationEnabled(true)
        else { await revokeCollaborationDevice(current.id, userId); toast.success(text('revoked')) }
        if (mounted.current) setConfirm(null)
        await load()
      })
    }}>{text(confirm === 'enable' ? 'enableDevices' : 'revoke')}</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
