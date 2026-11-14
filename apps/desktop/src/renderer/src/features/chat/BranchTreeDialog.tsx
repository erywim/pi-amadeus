import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, GitBranch, Loader2, User } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { BranchTreeNode, BranchTreeResponse } from '@pi-amadeus/shared'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { fetchMessageTree, setActiveLeafApi } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

interface TreeNode extends BranchTreeNode {
  children: TreeNode[]
}

/** 把按创建时间排序的扁平节点组装成树；父节点缺失的节点按根处理 */
function buildTree(nodes: BranchTreeNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  for (const node of nodes) map.set(node.id, { ...node, children: [] })
  const roots: TreeNode[] = []
  for (const node of map.values()) {
    const parent = node.parentId ? map.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: TreeNode[]): void => {
    list.sort((a, b) => a.createdAt - b.createdAt)
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}

/**
 * 消息分支树：完整展示所有保留的分支，当前活跃路径高亮。
 * 点任意旧分支节点 = 把活跃叶切到该分支的最新后代（不会删除任何消息）。
 */
export function BranchTreeDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.branchTreeOpen)
  const setOpen = useUiStore((s) => s.setBranchTreeOpen)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const session = useSessionStore((s) => s.sessions.find((item) => item.id === s.activeSessionId))
  const userId = useSessionStore((s) => s.userId)
  const refreshSession = useSessionStore((s) => s.refreshSession)
  const [data, setData] = useState<BranchTreeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    if (!open || !activeSessionId) return
    let cancelled = false
    setLoading(true)
    setData(null)
    fetchMessageTree(activeSessionId)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, activeSessionId])

  const roots = useMemo(() => (data ? buildTree(data.nodes) : []), [data])
  const branchPoints = data?.nodes.filter((node) => node.branchCount > 1).length ?? 0

  async function jumpTo(node: TreeNode): Promise<void> {
    if (!activeSessionId || !userId || node.active || switching) return
    setSwitching(true)
    try {
      await setActiveLeafApi({ sessionId: activeSessionId, userId, messageId: node.id })
      await refreshSession(activeSessionId)
      toast.success(t('branchTree.switched'))
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        data-testid="branch-tree"
        className="max-h-[78vh] w-[min(92vw,760px)] max-w-none gap-0 overflow-hidden rounded-2xl p-0"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-primary">
            <GitBranch className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[15px]">{t('branchTree.title')}</DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-[12px]">
              {session?.title || t('chatShell.untitledTask')} ·{' '}
              {t('branchTree.stats', { nodes: data?.nodes.length ?? 0, forks: branchPoints })}
            </DialogDescription>
          </div>
          <Badge variant="outline" className="mt-1 shrink-0 border-border text-[10.5px] text-muted-foreground">
            {t('branchTree.legend')}
          </Badge>
        </header>

        <div className="min-h-[160px] overflow-y-auto px-3 py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('branchTree.loading')}
            </div>
          ) : !data || data.nodes.length === 0 ? (
            <p className="px-4 py-16 text-center text-[13px] text-muted-foreground">
              {t('branchTree.empty')}
            </p>
          ) : (
            <div className="space-y-0.5">
              {roots.map((node) => (
                <TreeRow
                  key={node.id}
                  node={node}
                  depth={0}
                  activeLeafId={data.activeLeafId}
                  switching={switching}
                  onJump={(target) => void jumpTo(target)}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border px-5 py-2.5 text-[11.5px] text-muted-foreground">
          <span>{t('branchTree.hint')}</span>
          <span>{t('branchTree.closeHint')}</span>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function TreeRow({
  node,
  depth,
  activeLeafId,
  switching,
  onJump
}: {
  node: TreeNode
  depth: number
  activeLeafId: string | null
  switching: boolean
  onJump: (node: TreeNode) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const isLeaf = activeLeafId === node.id
  const disabled = node.active || switching

  return (
    <div className={cn(depth > 0 && 'ml-4 border-l border-border pl-3')}>
      <button
        type="button"
        data-testid="branch-tree-node"
        data-active={node.active}
        data-node-id={node.id}
        disabled={disabled}
        onClick={() => onJump(node)}
        title={node.active ? t('branchTree.currentPath') : t('branchTree.jump')}
        className={cn(
          'flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors',
          node.active
            ? 'bg-accent-soft/60 text-foreground'
            : 'text-ink-2 hover:bg-surface-soft hover:text-foreground',
          disabled && !node.active && 'opacity-60'
        )}
      >
        <span
          className={cn(
            'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border',
            node.role === 'user'
              ? 'border-border bg-surface text-muted-foreground'
              : node.active
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border bg-surface text-ink-2'
          )}
        >
          {node.role === 'user' ? <User className="size-3" /> : <Bot className="size-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <b className="text-[12px] font-semibold">
              {node.role === 'user' ? t('branchTree.roleUser') : t('branchTree.roleAssistant')}
            </b>
            {node.branchCount > 1 && (
              <Badge variant="outline" className="border-border px-1.5 py-0 text-[9.5px] text-muted-foreground">
                {t('branchTree.branch', { index: node.branchIndex, count: node.branchCount })}
              </Badge>
            )}
            {isLeaf && (
              <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-primary">
                <Check className="size-3" />
                {t('branchTree.currentLeaf')}
              </span>
            )}
            {!node.active && (
              <span className="text-[10.5px] text-muted-foreground">{t('branchTree.inactive')}</span>
            )}
          </span>
          <span
            className={cn(
              'mt-0.5 block truncate text-[12px] leading-relaxed',
              node.active ? 'text-ink-2' : 'text-muted-foreground'
            )}
          >
            {node.preview || t('branchTree.emptyMessage')}
          </span>
        </span>
      </button>
      {node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          activeLeafId={activeLeafId}
          switching={switching}
          onJump={onJump}
        />
      ))}
    </div>
  )
}
