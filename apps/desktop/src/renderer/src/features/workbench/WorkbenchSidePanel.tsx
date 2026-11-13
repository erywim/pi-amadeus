import * as React from 'react'
import { ChevronRight, FolderTree, GitBranch, Shapes, SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useArtifactStore } from '@renderer/stores/artifactStore'
import { ArtifactsView } from './ArtifactsView'
import { RunGraph } from './RunGraph'
import { TerminalView } from './TerminalView'
import { WorkspaceView } from './WorkspaceView'

type Tab = 'graph' | 'terminal' | 'workspace' | 'artifacts'

/**
 * 右侧工作台面板（右侧的三块区域）：
 * 运行图 / 终端 / 工件。点消息里的「预览」会自动切到工件页。
 */
export function WorkbenchSidePanel({ onCollapse }: { onCollapse: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const artifact = useArtifactStore((s) => s.artifact)
  const [tab, setTab] = React.useState<Tab>('graph')

  // 预览入口在聊天里：选中工件就自动切到工件页，否则用户看不到反馈
  React.useEffect(() => {
    if (artifact) setTab('artifacts')
  }, [artifact])

  const tabs: { key: Tab; icon: typeof GitBranch; label: string }[] = [
    { key: 'graph', icon: GitBranch, label: t('workbench.panel.graph') },
    { key: 'terminal', icon: SquareTerminal, label: t('workbench.panel.terminal') },
    { key: 'workspace', icon: FolderTree, label: t('workbench.panel.workspace') },
    { key: 'artifacts', icon: Shapes, label: t('workbench.panel.artifacts') }
  ]

  return (
    <aside
      data-testid="workbench-side-panel"
      className={cn(
        'flex shrink-0 flex-col border-l border-border bg-surface transition-[width] duration-150',
        // 工件预览需要更宽的画布；运行图/终端保持紧凑，给聊天留空间
        tab === 'artifacts' && artifact ? 'w-[min(46vw,520px)]' : tab === 'workspace' ? 'w-[360px]' : 'w-[330px]'
      )}
    >
      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-border px-2">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5">
          {tabs.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              data-testid={`panel-tab-${key}`}
              onClick={() => setTab(key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition-colors',
                tab === key
                  ? 'bg-surface-soft font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="size-3.5" strokeWidth={1.8} />
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="panel-collapse"
          onClick={onCollapse}
          title={t('workbench.panel.collapse')}
          aria-label={t('workbench.panel.collapse')}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'graph' && <RunGraph />}
        {tab === 'terminal' && <TerminalView />}
        {tab === 'workspace' && <WorkspaceView />}
        {tab === 'artifacts' && <ArtifactsView />}
      </div>
    </aside>
  )
}
