import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, FileInput, RefreshCw, Sparkles, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConversionCapabilities, ConversionFormat, ConversionOperationCapability, ConversionOperationId } from '@pi-amadeus/shared'
import { cn } from '@renderer/lib/utils'
import {
  convertFileApi,
  fetchConversionCapabilities,
  fetchConversionTargets,
  imagesToPdfApi,
  imagesToZipApi,
  mergePdfsApi,
  refreshConversionCapabilities
} from '@renderer/lib/api'

interface SelectedFile {
  file: File
  id: string
}

interface ResultFile {
  blob: Blob
  name: string
}

type PageOperation = 'convert' | 'images-to-pdf' | 'images-to-zip' | 'merge-pdfs'
const IMAGE_FORMATS = new Set<ConversionFormat>(['png', 'jpg', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'svg', 'ico', 'tga', 'jp2', 'jxl', 'qoi', 'ppm', 'raw'])
const PDF_FORMATS = new Set<ConversionFormat>(['pdf'])

function extensionOf(name: string): ConversionFormat {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return (ext === 'jpeg' ? 'jpg' : ext) as ConversionFormat
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function operationOf(capabilities: ConversionCapabilities | null, id: ConversionOperationCapability['id']): ConversionOperationCapability | undefined {
  return capabilities?.operations.find((operation) => operation.id === id)
}

function operationAvailable(capabilities: ConversionCapabilities | null, id: ConversionOperationId): boolean {
  const status = operationOf(capabilities, id)?.status
  return status === 'ready' || status === 'detected'
}

export default function ConversionPage(): React.JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const requestSequence = useRef(0)
  const [capabilities, setCapabilities] = useState<ConversionCapabilities | null>(null)
  const [capabilityError, setCapabilityError] = useState(false)
  const [selected, setSelected] = useState<SelectedFile[]>([])
  const [operation, setOperation] = useState<PageOperation>('convert')
  const [target, setTarget] = useState<ConversionFormat>('pdf')
  const [targetLoading, setTargetLoading] = useState(false)
  const [targets, setTargets] = useState<ConversionFormat[]>([])
  const [dragging, setDragging] = useState(false)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<ResultFile | null>(null)
  const [error, setError] = useState('')

  const engineRows = useMemo(() => capabilities?.engines ?? [], [capabilities])

  async function loadCapabilities(refresh = false): Promise<void> {
    setCapabilityError(false)
    try {
      const next = refresh ? await refreshConversionCapabilities() : await fetchConversionCapabilities()
      setCapabilities(next)
    } catch (loadError) {
      console.warn('[conversion] capability load failed:', loadError)
      setCapabilityError(true)
    }
  }

  useEffect(() => {
    void loadCapabilities()
  }, [])

  useEffect(() => {
    if (operation !== 'convert' || selected.length !== 1) {
      setTargets([])
      setTargetLoading(false)
      return
    }
    const sequence = ++requestSequence.current
    const extension = extensionOf(selected[0]!.file.name)
    setTargetLoading(true)
    void fetchConversionTargets(extension)
      .then((response) => {
        if (sequence !== requestSequence.current) return
        setTargets(response.targets)
        if (response.targets.length > 0 && !response.targets.includes(target)) setTarget(response.targets[0]!)
      })
      .catch(() => {
        if (sequence === requestSequence.current) setTargets([])
      })
      .finally(() => {
        if (sequence === requestSequence.current) setTargetLoading(false)
      })
  }, [operation, selected])

  function addFiles(files: File[]): void {
    setError('')
    setResult(null)
    const incoming = files.filter((file) => file.size > 0)
    if (incoming.length === 0) return
    setSelected((current) => {
      const room = Math.max(0, (capabilities?.limits.maxFiles ?? 50) - current.length)
      const additions = incoming.slice(0, room).map((file, index) => ({ file, id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}` }))
      return [...current, ...additions]
    })
  }

  function removeFile(id: string): void {
    setSelected((current) => current.filter((item) => item.id !== id))
  }

  function validForOperation(): boolean {
    if (operation === 'convert') return selected.length === 1 && targets.includes(target)
    if (operation === 'images-to-pdf' || operation === 'images-to-zip') return selected.length > 0 && selected.every((item) => IMAGE_FORMATS.has(extensionOf(item.file.name)))
    return selected.length >= 2 && selected.every((item) => PDF_FORMATS.has(extensionOf(item.file.name)))
  }

  async function runConversion(): Promise<void> {
    if (!validForOperation() || working) return
    setWorking(true)
    setError('')
    setResult(null)
    try {
      let output: { blob: Blob; name: string }
      if (operation === 'convert') output = await convertFileApi(selected[0]!.file, target)
      else if (operation === 'images-to-pdf') output = await imagesToPdfApi(selected.map((item) => item.file))
      else if (operation === 'images-to-zip') output = await imagesToZipApi(selected.map((item) => item.file))
      else output = await mergePdfsApi(selected.map((item) => item.file))
      setResult(output)
    } catch (conversionError) {
      const message = conversionError instanceof Error ? conversionError.message : String(conversionError)
      setError(message)
    } finally {
      setWorking(false)
    }
  }

  function downloadResult(): void {
    if (!result) return
    const url = URL.createObjectURL(result.blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = result.name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto grid max-w-[1120px] gap-8 px-8 pb-12 pt-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <main className="min-w-0">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-primary">
                <Sparkles className="size-3.5" />
                {t('conversion.eyebrow')}
              </div>
              <h1 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">{t('conversion.title')}</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{t('conversion.subtitle')}</p>
            </div>
            <button type="button" onClick={() => void loadCapabilities(true)} aria-label={t('conversion.refresh')} className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground">
              <RefreshCw className="size-4" />
            </button>
          </div>

          {capabilityError && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <span>{t('conversion.serviceOffline')}</span>
              <button type="button" onClick={() => void loadCapabilities()} className="font-semibold underline underline-offset-2">{t('conversion.retry')}</button>
            </div>
          )}

          <section
            className={cn('relative min-h-[210px] overflow-hidden rounded-2xl border border-dashed p-7 transition-colors', dragging ? 'border-primary bg-accent-soft' : 'border-line-strong bg-surface')}
            onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) setDragging(true) }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]) }}
          >
            <input ref={inputRef} type="file" multiple={operation !== 'convert'} className="hidden" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = '' }} />
            <div className="pointer-events-none absolute -right-10 -top-16 size-52 rounded-full bg-primary/5 blur-3xl" />
            <div className="relative flex min-h-[154px] flex-col items-center justify-center text-center">
              <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent text-primary">{dragging ? <Upload className="size-5" /> : <FileInput className="size-5" />}</span>
              <h2 className="text-[15px] font-semibold">{t('conversion.dropTitle')}</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">{t('conversion.dropHint')}</p>
              <button type="button" onClick={() => inputRef.current?.click()} className="pointer-events-auto mt-4 rounded-lg bg-foreground px-3.5 py-2 text-[13px] font-semibold text-accent-ink transition-transform hover:-translate-y-px">{t('conversion.chooseFiles')}</button>
            </div>
          </section>

          {selected.length > 0 && (
            <section className="mt-5 overflow-hidden rounded-xl border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-[13px] font-semibold">{t('conversion.selected', { count: selected.length })}</h2>
                <button type="button" onClick={() => setSelected([])} className="text-[12px] text-muted-foreground hover:text-foreground">{t('conversion.clear')}</button>
              </div>
              <div className="divide-y divide-border">
                {selected.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-soft text-muted-foreground"><FileInput className="size-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{item.file.name}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{formatBytes(item.file.size)}</span></span>
                    <button type="button" onClick={() => removeFile(item.id)} aria-label={t('conversion.removeFile')} className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-soft hover:text-foreground"><X className="size-3.5" /></button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="mt-5 grid gap-4 rounded-xl border border-border bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('conversion.operation')}</span>
              <select value={operation} onChange={(event) => { setOperation(event.target.value as PageOperation); setSelected([]); setTargets([]) }} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-primary">
                <option value="convert">{t('conversion.operations.convert')}</option>
                <option value="images-to-pdf" disabled={!operationAvailable(capabilities, 'images-to-pdf')}>{t('conversion.operations.imagesToPdf')}</option>
                <option value="images-to-zip" disabled={!operationAvailable(capabilities, 'images-to-zip')}>{t('conversion.operations.imagesToZip')}</option>
                <option value="merge-pdfs" disabled={!operationAvailable(capabilities, 'merge-pdfs')}>{t('conversion.operations.mergePdfs')}</option>
              </select>
            </label>
            {operation === 'convert' ? (
              <label className="block">
                <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('conversion.target')}</span>
                <select value={target} onChange={(event) => setTarget(event.target.value as ConversionFormat)} disabled={targetLoading || targets.length === 0} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-primary disabled:opacity-50">
                  {targetLoading ? <option>{t('conversion.loadingTargets')}</option> : targets.length === 0 ? <option>{t('conversion.noTargets')}</option> : targets.map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}
                </select>
              </label>
            ) : <div className="hidden sm:block" />}
            <button type="button" onClick={() => void runConversion()} disabled={!validForOperation() || working} className="h-10 rounded-lg bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40">{working ? t('conversion.converting') : t('conversion.convert')}</button>
          </section>

          {error && <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>}
          {result && <section className="mt-4 flex items-center gap-3 rounded-xl border border-mint/30 bg-mint/5 px-4 py-3"><span className="min-w-0 flex-1 truncate text-[13px] font-medium">{result.name}</span><button type="button" onClick={downloadResult} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-[12px] font-semibold text-accent-ink"><ArrowDownToLine className="size-3.5" />{t('conversion.download')}</button></section>}
          </main>

        <aside className="min-w-0">
          <div className="sticky top-6 rounded-xl border border-border bg-surface p-4">
            <div className="mb-4 flex items-center justify-between"><h2 className="text-[13px] font-semibold">{t('conversion.capabilities')}</h2><span className={cn('size-2 rounded-full', capabilityError ? 'bg-destructive' : 'bg-mint')} /></div>
            <div className="space-y-2">{(capabilities?.operations ?? []).map((item) => <div key={item.id} className="flex items-center gap-2 text-[12px]"><span className={cn('size-1.5 rounded-full', item.status === 'ready' ? 'bg-mint' : item.status === 'detected' ? 'bg-amber-sg' : 'bg-line-strong')} /><span className="min-w-0 flex-1 truncate">{item.label}</span><span className="text-[10px] uppercase text-muted-foreground">{item.status}</span></div>)}</div>
            <div className="my-4 border-t border-border" />
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('conversion.engines')}</h3>
            <div className="space-y-2">{engineRows.map((engine) => <div key={engine.id} className="flex items-center justify-between gap-3 text-[11px]"><span className="truncate text-muted-foreground">{engine.label}</span><span className="shrink-0 text-[10px] text-muted-foreground">{engine.status === 'detected' ? t('conversion.detected') : engine.status}</span></div>)}</div>
            <p className="mt-4 text-[11px] leading-5 text-muted-foreground">{t('conversion.localOnly')}</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
