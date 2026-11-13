import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, Loader2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { copyText } from '@renderer/lib/clipboard'
import { useArtifactStore } from '@renderer/stores/artifactStore'

/**
 * 工件预览（参考 Claude Artifacts / Cherry Studio）：
 * 助手代码块里的 HTML / SVG / Mermaid 在右侧沙箱里渲染。
 * iframe 用 sandbox 且不给 allow-same-origin——模型输出不可信，不能拿到应用上下文。
 */
export function ArtifactView(): React.JSX.Element | null {
  const { t } = useTranslation()
  const artifact = useArtifactStore((s) => s.artifact)
  const close = useArtifactStore((s) => s.close)
  const [rendered, setRendered] = useState('')
  const [error, setError] = useState('')
  const [copying, setCopying] = useState(false)
  const renderId = useRef(0)

  const kind = artifact?.lang.toLowerCase() ?? ''
  const isMermaid = kind === 'mermaid'
  const srcDoc = useMemo(() => {
    if (!artifact) return ''
    if (kind === 'svg') {
      return `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;display:grid;place-items:center;background:#0b0f14}
        svg{max-width:96vw;max-height:94vh}
        body{color:#e6edf3;font-family:system-ui,sans-serif}
      </style></head><body>${artifact.code}</body></html>`
    }
    // html：原样交给沙箱 iframe（允许脚本，但没有同源权限）
    return artifact.code
  }, [artifact, kind])

  useEffect(() => {
    if (!artifact || !isMermaid) return
    let cancelled = false
    const id = ++renderId.current
    setError('')
    setRendered('')
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif'
        })
        const result = await mermaid.render(`amadeus-artifact-${id}`, artifact.code)
        if (!cancelled) setRendered(result.svg)
      } catch (renderError) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : String(renderError))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [artifact, isMermaid])

  if (!artifact) return null

  async function handleCopy(): Promise<void> {
    if (!artifact) return
    try {
      await copyText(artifact.code)
      setCopying(true)
      toast.success(t('chat.copied'))
      window.setTimeout(() => setCopying(false), 1500)
    } catch {
      toast.error(t('chat.copyFailed'))
    }
  }

  function handleDownload(): void {
    if (!artifact) return
    const extension = kind === 'mermaid' ? 'mmd' : kind === 'svg' ? 'svg' : 'html'
    const blob = new Blob([artifact.code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `amadeus-artifact-${Date.now()}.${extension}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div
      data-testid="artifact-panel"
      className="flex h-full min-h-0 flex-col bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {artifact.lang}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
          {artifact.title || t('chat.artifact')}
        </span>
        <button
          type="button"
          data-testid="artifact-copy"
          onClick={() => void handleCopy()}
          title={t('chat.artifactCopy')}
          aria-label={t('chat.artifactCopy')}
          className="rounded p-1 text-muted-foreground hover:bg-surface-soft hover:text-foreground"
        >
          {copying ? <Check className="size-3.5 text-mint" /> : <Copy className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          title={t('chat.artifactDownload')}
          aria-label={t('chat.artifactDownload')}
          className="rounded p-1 text-muted-foreground hover:bg-surface-soft hover:text-foreground"
        >
          <Download className="size-3.5" />
        </button>
        <button
          type="button"
          data-testid="artifact-close"
          onClick={close}
          title={t('chat.artifactClose')}
          aria-label={t('chat.artifactClose')}
          className="rounded p-1 text-muted-foreground hover:bg-surface-soft hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-[#0b0f14]">
        {isMermaid ? (
          error ? (
            <div className="p-4">
              <p className="text-[12.5px] font-medium text-destructive">{t('chat.artifactError')}</p>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-white/60">
                {error}
              </pre>
            </div>
          ) : rendered ? (
            <div
              data-testid="artifact-mermaid"
              className="grid h-full place-items-center overflow-auto p-4 [&_svg]:max-h-full [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: rendered }}
            />
          ) : (
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-white/50" />
            </div>
          )
        ) : (
          <iframe
            data-testid="artifact-frame"
            title={t('chat.artifact')}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            srcDoc={srcDoc}
            className="size-full border-0 bg-white"
          />
        )}
      </div>
      <p className="border-t border-border px-3 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t('chat.artifactHint')}
      </p>
    </div>
  )
}
