import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type {
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceGitFile,
  WorkspaceGitStatus,
  WorkspaceInfo
} from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { copyText } from '@renderer/lib/clipboard'
import {
  fetchWorkspaceDiff,
  fetchWorkspaceFile,
  fetchWorkspaceGit,
  fetchWorkspaceInfo,
  fetchWorkspaceTree
} from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { useUiStore } from '@renderer/stores/uiStore'

type Tab = 'files' | 'changes'
type Preview =
  | { kind: 'file'; file: WorkspaceFile }
  | { kind: 'diff'; diff: WorkspaceDiff }

const STATUS_STYLE: Record<string, string> = {
  M: 'border-amber-500/40 text-amber-600',
  A: 'border-emerald-500/40 text-emerald-600',
  D: 'border-destructive/40 text-destructive',
  R: 'border-sky-500/40 text-sky-600',
  '??': 'border-border text-muted-foreground'
}

/**
 * 只读工作区面板：真实文件树 + Git 变更。
 * 文件正文与 diff 在弹窗里看，侧栏保持可浏览的密度。
 */
export function WorkspaceView(): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('files')
  const [info, setInfo] = useState<WorkspaceInfo | null>(null)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [git, setGit] = useState<WorkspaceGitStatus | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const diffRequest = useUiStore((s) => s.workspaceDiffRequest)
  const clearDiffRequest = useUiStore((s) => s.clearWorkspaceDiffRequest)

  async function loadAll(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [nextInfo, tree, nextGit] = await Promise.all([
        fetchWorkspaceInfo(),
        fetchWorkspaceTree(),
        fetchWorkspaceGit()
      ])
      setInfo(nextInfo)
      setEntries(tree.entries)
      setGit(nextGit)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  // 消息里的「改动卡」请求打开某个文件的 diff：切到变更页并直接打开预览
  useEffect(() => {
    if (!diffRequest) return
    clearDiffRequest()
    setTab('changes')
    setPreviewLoading(true)
    fetchWorkspaceDiff(diffRequest.path)
      .then((diff) => setPreview({ kind: 'diff', diff }))
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setPreviewLoading(false))
  }, [diffRequest, clearDiffRequest])

  const visibleEntries = useMemo(() => {
    if (collapsed.size === 0) return entries
    return entries.filter((entry) => {
      for (const dir of collapsed) {
        if (entry.path.startsWith(`${dir}/`)) return false
      }
      return true
    })
  }, [entries, collapsed])

  function toggleDir(path: string): void {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function openFile(entry: WorkspaceEntry): Promise<void> {
    if (entry.kind === 'dir') {
      toggleDir(entry.path)
      return
    }
    setPreviewLoading(true)
    try {
      setPreview({ kind: 'file', file: await fetchWorkspaceFile(entry.path) })
    } catch (openError) {
      toast.error(openError instanceof Error ? openError.message : String(openError))
    } finally {
      setPreviewLoading(false)
    }
  }

  async function openDiff(file: WorkspaceGitFile): Promise<void> {
    setPreviewLoading(true)
    try {
      setPreview({ kind: 'diff', diff: await fetchWorkspaceDiff(file.path) })
    } catch (openError) {
      toast.error(openError instanceof Error ? openError.message : String(openError))
    } finally {
      setPreviewLoading(false)
    }
  }

  async function copyPreview(): Promise<void> {
    if (!preview) return
    const text = preview.kind === 'file' ? preview.file.content : preview.diff.diff
    try {
      await copyText(text)
      toast.success(t('workspace.copied'))
    } catch {
      toast.error(t('workspace.copyFailed'))
    }
  }

  return (
    <div data-testid="workspace-view" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          data-testid="workspace-tab-files"
          onClick={() => setTab('files')}
          className={cn(
            'rounded-md px-2 py-1 text-[11.5px] transition-colors',
            tab === 'files'
              ? 'bg-surface-soft font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('workspace.files')}
        </button>
        <button
          type="button"
          data-testid="workspace-tab-changes"
          onClick={() => setTab('changes')}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] transition-colors',
            tab === 'changes'
              ? 'bg-surface-soft font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('workspace.changes')}
          {git && git.changedCount > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 text-[9.5px] font-semibold text-primary">
              {git.changedCount}
            </span>
          )}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="workspace-refresh"
          onClick={() => void loadAll()}
          title={t('workspace.refresh')}
          aria-label={t('workspace.refresh')}
          className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[10.5px] text-muted-foreground">
        {info?.isRepo ? (
          <>
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono">{info.branch || 'HEAD'}</span>
          </>
        ) : (
          <span className="truncate">{t('workspace.notRepo')}</span>
        )}
        <span className="flex-1" />
        <span className="max-w-[45%] truncate font-mono" title={info?.root}>
          {info?.name ?? '…'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error ? (
          <p className="px-3 py-6 text-[12px] leading-relaxed text-destructive">{error}</p>
        ) : loading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('workspace.loading')}
          </div>
        ) : tab === 'files' ? (
          <FileTree
            entries={visibleEntries}
            collapsed={collapsed}
            onOpen={(entry) => void openFile(entry)}
          />
        ) : (
          <ChangeList git={git} onOpen={(file) => void openDiff(file)} />
        )}
      </div>

      {previewLoading && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t('workspace.loading')}
        </div>
      )}

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="flex max-h-[82vh] w-[min(94vw,900px)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0">
          {preview && (
            <PreviewBody preview={preview} onCopy={() => void copyPreview()} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FileTree({
  entries,
  collapsed,
  onOpen
}: {
  entries: WorkspaceEntry[]
  collapsed: Set<string>
  onOpen: (entry: WorkspaceEntry) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (entries.length === 0) {
    return <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">{t('workspace.empty')}</p>
  }
  return (
    <div className="space-y-px">
      {entries.map((entry) => {
        const isDir = entry.kind === 'dir'
        const isCollapsed = collapsed.has(entry.path)
        return (
          <button
            key={entry.path}
            type="button"
            data-testid={isDir ? 'workspace-dir' : 'workspace-file'}
            data-path={entry.path}
            onClick={() => onOpen(entry)}
            title={entry.path}
            className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[12px] text-ink-2 transition-colors hover:bg-surface-soft hover:text-foreground"
            style={{ paddingLeft: 8 + entry.depth * 12 }}
          >
            {isDir ? (
              <>
                {isCollapsed ? (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                )}
                {isCollapsed ? (
                  <Folder className="size-3.5 shrink-0 text-amber-500/80" />
                ) : (
                  <FolderOpen className="size-3.5 shrink-0 text-amber-500/80" />
                )}
              </>
            ) : (
              <>
                <span className="size-3 shrink-0" />
                <File className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          </button>
        )
      })}
    </div>
  )
}

function ChangeList({
  git,
  onOpen
}: {
  git: WorkspaceGitStatus | null
  onOpen: (file: WorkspaceGitFile) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (!git?.isRepo) {
    return <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">{t('workspace.noGit')}</p>
  }
  if (git.files.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-10 text-[12px] text-muted-foreground">
        <Check className="size-4 text-emerald-500" />
        {t('workspace.clean')}
      </div>
    )
  }
  return (
    <div className="space-y-px">
      {git.files.map((file) => (
        <button
          key={file.path}
          type="button"
          data-testid="workspace-change"
          data-path={file.path}
          onClick={() => onOpen(file)}
          title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-surface-soft"
        >
          <Badge
            variant="outline"
            className={cn(
              'shrink-0 px-1.5 py-0 font-mono text-[9.5px]',
              STATUS_STYLE[file.status] ?? STATUS_STYLE['??']
            )}
          >
            {file.status}
          </Badge>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-ink-2">{file.path}</span>
            {file.staged && (
              <span className="text-[10px] text-muted-foreground">{t('workspace.staged')}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}

function PreviewBody({
  preview,
  onCopy
}: {
  preview: Preview
  onCopy: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const isFile = preview.kind === 'file'
  const file = isFile ? preview.file : null
  const diff = isFile ? null : preview.diff
  const body = file?.content ?? diff?.diff ?? ''
  const lines = body.split('\n')

  return (
    <>
      <header className="flex items-start gap-3 border-b border-border px-5 py-3.5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-primary">
          <FileCode2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate font-mono text-[13px]">
            {isFile ? file?.path : diff?.path}
          </DialogTitle>
          <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            {isFile && file && (
              <>
                <span>{file.language}</span>
                <span>·</span>
                <span>{formatBytes(file.size)}</span>
              </>
            )}
            {!isFile && diff?.untracked && <span>{t('workspace.untracked')}</span>}
            {!isFile && !diff?.untracked && <span>{t('workspace.diff')}</span>}
            {(file?.truncated || diff?.truncated) && (
              <span className="text-amber-600">{t('workspace.truncated')}</span>
            )}
          </DialogDescription>
        </div>
        <button
          type="button"
          onClick={onCopy}
          disabled={!body}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[11.5px] text-ink-2 transition-colors hover:bg-surface-soft disabled:opacity-40"
        >
          <Copy className="size-3" />
          {t('workspace.copy')}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-[#0f1117] text-[#d7dce5]">
        {file?.binary || diff?.binary ? (
          <p className="px-5 py-10 text-center text-[12px] text-[#8b93a1]">{t('workspace.binary')}</p>
        ) : body ? (
          isFile ? (
            <pre className="min-w-full p-4 font-mono text-[12px] leading-[1.65] whitespace-pre">
              {body}
            </pre>
          ) : (
            <div className="min-w-full py-3 font-mono text-[12px] leading-[1.65]">
              {lines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    'whitespace-pre px-4',
                    line.startsWith('+++') || line.startsWith('---')
                      ? 'text-[#8b93a1]'
                      : line.startsWith('+')
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : line.startsWith('-')
                          ? 'bg-rose-500/10 text-rose-300'
                          : line.startsWith('@@')
                            ? 'text-sky-300'
                            : line.startsWith('diff ')
                              ? 'text-[#8b93a1]'
                              : undefined
                  )}
                >
                  {line || ' '}
                </div>
              ))}
            </div>
          )
        ) : (
          <p className="px-5 py-10 text-center text-[12px] text-[#8b93a1]">{t('workspace.noDiff')}</p>
        )}
      </div>
      <footer className="flex items-center justify-between border-t border-border px-5 py-2 text-[10.5px] text-muted-foreground">
        <span>{t('workspace.readonly')}</span>
        <span>{isFile ? t('workspace.lines', { count: lines.length }) : ''}</span>
      </footer>
    </>
  )
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
