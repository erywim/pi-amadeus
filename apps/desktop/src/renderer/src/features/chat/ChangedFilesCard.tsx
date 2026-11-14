import * as React from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TurnChangedFile } from '@pi-amadeus/shared'
import { cn } from '@renderer/lib/utils'
import { useUiStore } from '@renderer/stores/uiStore'

/** 变更状态 → 颜色（和工作区面板保持一致） */
const STATUS_TONE: Record<string, string> = {
  M: 'text-amber-600',
  A: 'text-emerald-600',
  D: 'text-destructive',
  R: 'text-sky-600',
  '??': 'text-muted-foreground'
}

/**
 * 每回合工作区改动卡：只有服务端在真实 git 快照里发现差异时才出现。
 * 点文件名 = 在右侧工作区面板里打开该文件的未提交 diff；快照未知（非 Git / 无 shell 工具）时整卡不渲染。
 */
export function ChangedFilesCard({
  files
}: {
  files: TurnChangedFile[]
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const requestWorkspaceDiff = useUiStore((s) => s.requestWorkspaceDiff)
  const [open, setOpen] = React.useState(files.length <= 4)

  React.useEffect(() => {
    setOpen(files.length <= 4)
  }, [files])

  if (files.length === 0) return null

  return (
    <div
      data-testid="changed-files-card"
      className="overflow-hidden rounded-[10px] border border-border bg-background"
    >
      <button
        type="button"
        data-testid="changed-files-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] text-ink-2 transition-colors hover:bg-surface-soft"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <FileDiff className="size-3.5 shrink-0 text-primary" />
        <span>{t('chatShell.changedFiles', { count: files.length })}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {t('chatShell.changedFilesHint')}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 border-t border-border px-2 py-1.5">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              data-testid="changed-file"
              data-path={file.path}
              title={file.path}
              onClick={() => requestWorkspaceDiff(file.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-soft"
            >
              <span
                className={cn(
                  'w-4 shrink-0 text-center font-mono text-[10px] font-semibold',
                  STATUS_TONE[file.status] ?? 'text-muted-foreground'
                )}
              >
                {file.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">
                {file.path}
              </span>
              <span className="shrink-0 text-[10.5px] text-muted-foreground">
                {t('chatShell.viewDiff')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
