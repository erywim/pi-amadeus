import * as React from 'react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Bot, Check, Layers, LayoutGrid, List, LoaderCircle, Pencil, Plus, RefreshCw, Search, Terminal, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import type { AgentProfile, AgentTaskStatus } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agentStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { DeleteProfileDialog, ProfileDialog, TaskDialog, type TaskDialogMode } from './AgentDialogs'
import { DevicesPanel } from './DevicesPanel'
import { RelayPanel } from './RelayPanel'
import { TaskBoard } from './TaskBoard'
import { TaskTranscript } from './TaskTranscript'
import { useAgentText } from './translations'

const statuses: AgentTaskStatus[] = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted']
const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background'

/** Agent 工作台是持久任务的投影，不借用聊天 store 的流或停止逻辑。 */
export default function AgentsPage(): React.JSX.Element {
  const text = useAgentText()
  const userId = useSessionStore((state) => state.userId)
  const profiles = useAgentStore((state) => state.profiles)
  const discovered = useAgentStore((state) => state.discovered)
  const tasks = useAgentStore((state) => state.tasks)
  const maxConcurrent = useAgentStore((state) => state.maxConcurrent)
  const loading = useAgentStore((state) => state.loading)
  const loaded = useAgentStore((state) => state.loaded)
  const error = useAgentStore((state) => state.error)
  const connection = useAgentStore((state) => state.connection)
  const selectedId = useAgentStore((state) => state.selectedId)
  const connect = useAgentStore((state) => state.connect)
  const refresh = useAgentStore((state) => state.refresh)
  const [agentFilter, setAgentFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<AgentTaskStatus | ''>('')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const [view, setView] = useState<'canvas' | 'list'>('canvas')
  const [profileDialog, setProfileDialog] = useState<{ profile?: AgentProfile } | null>(null)
  const [deleteProfile, setDeleteProfile] = useState<AgentProfile | null>(null)
  const [taskDialog, setTaskDialog] = useState<TaskDialogMode | null>(null)

  useEffect(() => {
    if (!userId) return
    return connect(userId)
  }, [userId, connect])

  useEffect(() => { if (error) toast.error(error, { id: 'agent-workbench-error' }) }, [error])

  const filteredTasks = useMemo(() => tasks.filter((task) =>
    (!agentFilter || task.agentId === agentFilter) && (!statusFilter || task.status === statusFilter) &&
    (!deferredQuery || `${task.title}\n${task.prompt}\n${task.id}\n${task.agentName}`.toLocaleLowerCase().includes(deferredQuery))
  ).sort((a, b) => b.createdAt - a.createdAt), [tasks, agentFilter, statusFilter, deferredQuery])
  const selected = tasks.find((task) => task.id === selectedId) ?? null
  const enabledProfiles = profiles.some((profile) => profile.enabled)

  function clearFilters(): void { setAgentFilter(''); setStatusFilter(''); setQuery('') }
  function openTask(): void {
    // 新建始终是显式操作；优先用户所选配置，其次服务端内置 amadeus，不自动执行。
    setTaskDialog({ kind: 'create', ...(agentFilter ? { agentId: agentFilter } : {}) })
  }

  if (!userId) return <main data-testid="agents-page" className="grid h-full place-items-center px-6"><div className="text-center"><Bot aria-hidden="true" className="mx-auto mb-3 size-7 text-primary" /><h1 className="text-lg font-semibold">{text('title')}</h1><p className="mt-2 text-sm text-muted-foreground">{text('login')}</p></div></main>

  return <main data-testid="agents-page" className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-background text-foreground xl:overflow-hidden [&_button]:motion-reduce:transition-none [&_input]:motion-reduce:transition-none">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-5 sm:px-6">
      <div className="min-w-0"><p className="font-mono text-[9px] tracking-[0.2em] text-primary">AMADEUS / LOCAL OPERATIONS</p><h1 className="mt-1.5 font-mono text-[21px] font-semibold tracking-tight">{text('title')}</h1><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text('subtitle')}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-2 flex items-center gap-1.5 text-[10px] text-muted-foreground" role="status" data-testid="agent-connection" data-state={connection}><span className={cn('size-1.5 rounded-full', connection === 'live' ? 'bg-mint' : 'bg-muted-foreground', connection === 'connecting' && 'motion-safe:animate-pulse')} aria-hidden="true" />{text(`connection.${connection}`)}</span>
        <Button type="button" variant="outline" size="sm" data-testid="agents-refresh" aria-label={text('refresh')} disabled={loading} onClick={() => void refresh().catch(() => undefined)}><RefreshCw className={cn(loading && 'motion-safe:animate-spin')} aria-hidden="true" /></Button>
        <Button type="button" size="sm" data-testid="agent-task-new" onClick={openTask} disabled={!loaded || !enabledProfiles}><Plus aria-hidden="true" />{text('newTask')}</Button>
      </div>
    </header>
    <Tabs defaultValue="tasks" className="min-h-0 flex-1 gap-0">
      <div className="shrink-0 border-b border-border px-4 sm:px-6"><TabsList className="h-11 justify-start gap-4 rounded-none bg-transparent p-0"><TabsTrigger data-testid="agents-tab-tasks" value="tasks" className="h-full rounded-none border-b-2 border-transparent px-0 text-xs transition-colors data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none">{text('tasks')}</TabsTrigger><TabsTrigger data-testid="agents-tab-devices" value="devices" className="h-full rounded-none border-b-2 border-transparent px-0 text-xs transition-colors data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none">{text('devices')}</TabsTrigger></TabsList></div>
      <TabsContent value="tasks" className="mt-0 min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col">
        {error && <div role="alert" data-testid="agents-error" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/5 px-5 py-2 text-xs text-destructive"><span>{error}</span><Button type="button" variant="ghost" size="sm" onClick={() => void refresh().catch(() => undefined)}>{text('retry')}</Button></div>}
        <div className="grid min-h-0 flex-1 md:grid-cols-[184px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(300px,1fr)_320px]">
          <aside className="flex min-h-0 flex-col border-b border-border bg-surface-soft/35 md:row-span-2 md:border-b-0 md:border-r xl:row-span-1" aria-label={text('roster')}>
            <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-4"><h2 className="text-xs font-semibold">{text('roster')}</h2><Button type="button" variant="ghost" size="sm" className="size-6 p-0" data-testid="agent-profile-add" aria-label={text('addAgent')} disabled={!loaded} onClick={() => setProfileDialog({})}><Plus aria-hidden="true" className="size-3.5" /></Button></div>
            <div className="max-h-64 min-h-0 overflow-y-auto px-2 pb-3 md:max-h-none md:flex-1">
              <button type="button" data-testid="agent-filter-all" aria-pressed={!agentFilter} onClick={() => setAgentFilter('')} className={cn('mb-2 flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-left text-xs', focusClass, !agentFilter ? 'bg-accent-soft font-medium text-primary' : 'text-ink-2 hover:bg-muted')}><Layers className="size-3.5" aria-hidden="true" />{text('allAgents')}<span className="ml-auto font-mono text-[10px]">{tasks.length}</span></button>
              {loaded && profiles.length === 0 && <p className="px-2.5 py-4 text-xs leading-relaxed text-muted-foreground">{text('noAgents')}</p>}
              {profiles.map((profile) => {
                const detection = discovered.find((item) => item.runtime === profile.runtime)
                const activeCount = tasks.filter((task) => task.agentId === profile.id && ['queued', 'running', 'waiting_approval'].includes(task.status)).length
                return <div key={profile.id} data-testid="agent-roster-row" data-agent-id={profile.id} className={cn('mb-1 rounded-lg border', agentFilter === profile.id ? 'border-primary/20 bg-accent-soft' : 'border-transparent')}>
                  <button type="button" data-testid="agent-roster-select" aria-pressed={agentFilter === profile.id} onClick={() => setAgentFilter(profile.id)} className={cn('block w-full rounded-t-lg px-2.5 pb-1 pt-2.5 text-left', focusClass)}>
                    <span className="flex items-center gap-2"><span className={cn('grid size-7 shrink-0 place-items-center rounded-md border bg-surface font-mono text-[10px] font-semibold', profile.enabled ? 'border-primary/20 text-primary' : 'border-border text-muted-foreground')}>{profile.name.slice(0, 2).toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-xs font-medium">{profile.name}</span><span className="block font-mono text-[9px] text-muted-foreground">{profile.runtime}</span></span>{activeCount > 0 && <span className="ml-auto rounded-full bg-primary/10 px-1.5 font-mono text-[10px] text-primary">{activeCount}</span>}</span>
                    <span className="mt-2 block text-[9px] text-muted-foreground">{!profile.enabled ? text('disabled') : detection ? text(detection.installed ? 'installed' : 'notInstalled') : text('unknown')} · {text(profile.allowRemote ? 'remoteAllowed' : 'localOnly')}</span>
                  </button>
                  <div className="flex justify-end gap-0.5 px-1.5 pb-1.5"><Button type="button" variant="ghost" size="sm" data-testid="agent-profile-edit" aria-label={`${text('editAgent')} ${profile.name}`} className="size-6 p-0 text-muted-foreground" onClick={() => setProfileDialog({ profile })}><Pencil aria-hidden="true" className="size-3" /></Button><Button type="button" variant="ghost" size="sm" data-testid="agent-profile-delete" aria-label={`${text('deleteAgent')} ${profile.name}`} className="size-6 p-0 text-muted-foreground hover:text-destructive" onClick={() => setDeleteProfile(profile)}><Trash2 aria-hidden="true" className="size-3" /></Button></div>
                </div>
              })}
              <Button type="button" variant="ghost" size="sm" className="mt-2 w-full justify-start px-2.5 text-xs text-muted-foreground" disabled={!loaded} onClick={() => setProfileDialog({})}><Plus aria-hidden="true" />{text('addAgent')}</Button>
            </div>
            <details className="shrink-0 border-t border-border px-4 py-3">
              <summary className={cn('cursor-pointer rounded text-[10px] font-medium text-muted-foreground', focusClass)}>{text('discovery')}</summary>
              <div className="mt-3 grid max-h-60 gap-3 overflow-y-auto">{discovered.map((item) => <div key={item.runtime} data-testid="agent-discovered" data-runtime={item.runtime} className="text-[10px]"><p className="flex items-center gap-1.5 font-mono text-ink-2">{item.installed ? <Check className="size-3 text-mint" aria-hidden="true" /> : <Terminal className="size-3 text-muted-foreground" aria-hidden="true" />}{item.name}</p><p className="mt-1 text-muted-foreground">{text(item.installed ? 'installed' : 'notInstalled')} · {text(item.supported ? 'supported' : 'unsupported')}</p>{item.path && <p className="mt-1 break-all font-mono text-muted-foreground">{item.path}</p>}{item.version && <p className="mt-1 break-words font-mono text-muted-foreground">{item.version}</p>}{item.note && <p className="mt-1 leading-relaxed text-muted-foreground">{item.note}</p>}</div>)}</div>
            </details>
          </aside>
          <section className="flex min-h-[540px] min-w-0 flex-col xl:min-h-0" aria-label={text('tasks')}>
            <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-4">
              <div className="min-w-0 flex-1"><h2 className="text-xs font-semibold">{text(view === 'canvas' ? 'canvas' : 'list')}<span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">{filteredTasks.length}/{tasks.length}</span></h2>{loaded && <p className="mt-1 text-[10px] text-muted-foreground">{text('concurrency')} / {maxConcurrent}</p>}</div>
              <div className="flex items-center rounded-md border border-border p-0.5" role="group" aria-label={text('canvas')}><Button type="button" variant={view === 'canvas' ? 'secondary' : 'ghost'} size="sm" className="size-7 p-0" data-testid="agent-view-canvas" aria-label={text('canvas')} aria-pressed={view === 'canvas'} onClick={() => setView('canvas')}><LayoutGrid aria-hidden="true" /></Button><Button type="button" variant={view === 'list' ? 'secondary' : 'ghost'} size="sm" className="size-7 p-0" data-testid="agent-view-list" aria-label={text('list')} aria-pressed={view === 'list'} onClick={() => setView('list')}><List aria-hidden="true" /></Button></div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 border-b border-border px-4 pb-3"><label className="relative min-w-0 flex-[1_1_160px]"><span className="sr-only">{text('search')}</span><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" aria-hidden="true" /><Input data-testid="agent-task-search" className="h-8 pl-8 text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text('search')} /></label><label className="min-w-0 flex-[0_1_130px]"><span className="sr-only">{text('statusLabel')}</span><select data-testid="agent-task-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AgentTaskStatus | '')} className={cn('h-8 w-full rounded-md border border-border bg-surface px-2 text-xs', focusClass)}><option value="">{text('allStatuses')}</option>{statuses.map((status) => <option key={status} value={status}>{text(`status.${status}`)}</option>)}</select></label></div>
            {!loaded ? <div className="grid flex-1 place-items-center px-6 py-16"><p role="status" data-testid="agents-loading" className="flex items-center gap-2 text-xs text-muted-foreground">{!error && <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />}{error ?? text('loading')}</p></div> : filteredTasks.length ? <><TaskBoard tasks={filteredTasks} selectedId={selectedId} view={view} />{view === 'canvas' && <p id="agent-canvas-help" className="shrink-0 border-t border-border bg-background px-4 py-2 text-[10px] leading-relaxed text-muted-foreground">{text('canvasHelp')}</p>}</> : <div data-testid="agent-board-empty" className="grid flex-1 place-items-center px-5 py-16 text-center"><div className="max-w-xs"><div className="mb-5 flex items-center justify-center gap-3 font-mono text-[10px] text-primary/50"><span className="h-px w-8 bg-primary/20" />[ TASK / 00 ]<span className="h-px w-8 bg-primary/20" /></div><h3 className="text-base font-semibold">{text(tasks.length ? 'noResults' : 'emptyTitle')}</h3><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{text(tasks.length ? 'search' : 'emptyDescription')}</p><Button type="button" className="mt-5" variant="outline" size="sm" disabled={!tasks.length && !enabledProfiles} onClick={tasks.length ? clearFilters : openTask}>{tasks.length ? <RefreshCw aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}{text(tasks.length ? 'clearFilters' : 'newTask')}</Button></div></div>}
          </section>
          <div className="min-h-0 min-w-0 md:col-start-2 xl:col-start-3 xl:flex xl:flex-col [&>aside]:xl:flex-1"><TaskTranscript key={selected?.id ?? 'none'} task={selected} userId={userId} onFollowup={setTaskDialog} /></div>
        </div>
      </TabsContent>
      <TabsContent value="devices" className="mt-0 min-h-0 flex-1 overflow-y-auto"><DevicesPanel key={userId} userId={userId} /><RelayPanel userId={userId} /></TabsContent>
    </Tabs>
    {profileDialog && <ProfileDialog key={profileDialog.profile?.id ?? 'new'} profile={profileDialog.profile} onClose={() => setProfileDialog(null)} />}
    {deleteProfile && <DeleteProfileDialog profile={deleteProfile} onClose={() => setDeleteProfile(null)} />}
    {taskDialog && <TaskDialog mode={taskDialog} userId={userId} onClose={() => setTaskDialog(null)} />}
  </main>
}
