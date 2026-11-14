import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Check, CornerDownRight, Pause, Square, X } from 'lucide-react'
import toast from 'react-hot-toast'
import type { AgentTask } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { AgentApiError } from '@renderer/lib/agentApi'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agentStore'
import { useAgentText } from './translations'
import { TaskStatus } from './TaskBoard'
import type { TaskDialogMode } from './AgentDialogs'

const activeStatuses = new Set(['queued', 'running', 'waiting_approval'])

export function TaskTranscript({ task, userId, onFollowup }: {
  task: AgentTask | null; userId: string; onFollowup: (mode: TaskDialogMode) => void
}): React.JSX.Element {
  const text = useAgentText()
  const tasks = useAgentStore((state) => state.tasks)
  const taskAction = useAgentStore((state) => state.taskAction)
  const selectTask = useAgentStore((state) => state.selectTask)
  const busy = useAgentStore((state) => task ? state.busyTasks[task.id] ?? false : false)
  const [now, setNow] = useState(Date.now)
  const output = useRef<HTMLPreElement>(null)
  const followOutput = useRef(true)
  const approvalExpiry = task?.pendingApproval?.expiresAt

  useEffect(() => {
    if (!approvalExpiry) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [approvalExpiry])

  useEffect(() => {
    // 仅在用户仍靠近末尾时跟随新日志，不抢走正在回看的滚动位置。
    if (output.current && followOutput.current) output.current.scrollTop = output.current.scrollHeight
  }, [task?.output])

  const formatDate = (date: number): string => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
  if (!task) return <aside data-testid="agent-transcript" className="flex min-h-72 flex-col border-t border-border bg-surface xl:min-h-0 xl:border-l xl:border-t-0">
    <h2 className="border-b border-border px-5 py-4 text-xs font-semibold">{text('transcript')}</h2>
    <div className="grid flex-1 place-items-center px-6 py-12 text-center"><div><CornerDownRight className="mx-auto mb-3 size-6 text-primary/40" aria-hidden="true" /><p className="text-xs leading-relaxed text-muted-foreground">{text('noSelection')}</p></div></div>
  </aside>

  const active = activeStatuses.has(task.status)
  const approval = task.pendingApproval
  const expired = approval ? approval.expiresAt <= now : false
  const nextTasks = tasks.filter((candidate) => candidate.parentTaskId === task.id || candidate.resumeOf === task.id)
  const related = [...new Set([...(task.parentTaskId ? [task.parentTaskId] : []), ...(task.resumeOf ? [task.resumeOf] : []), ...task.dependsOn])]

  async function act(action: 'stop' | 'approve', approved?: boolean): Promise<void> {
    if (!task) return
    try {
      // 审批身份绑定用户看到的这一帧，不重读 store，否则旧命令 A 的点击可能批准新命令 B。
      if (action === 'approve' && !approval) return
      await taskAction(task.id, action, {
        userId,
        ...(action === 'approve' && approval ? { approved, turnId: approval.turnId, toolCallId: approval.toolCallId } : {})
      })
      toast.success(text(action === 'stop' ? 'stopped' : 'approvalSent'))
    } catch (error) {
      if (action === 'approve' && error instanceof AgentApiError && error.status === 409) {
        // 过期审批只刷新真实快照，绝不替用户自动批准下一条命令。
        await useAgentStore.getState().refresh().catch(() => undefined)
      }
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return <aside data-testid="agent-transcript" data-task-id={task.id} className="flex min-h-[560px] min-w-0 flex-col overflow-hidden border-t border-border bg-surface xl:min-h-0 xl:border-l xl:border-t-0">
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h2 className="text-xs font-semibold">{text('transcript')}</h2>
      <Button variant="ghost" size="sm" className="size-7 p-0 motion-reduce:transition-none" aria-label={text('close')} onClick={() => selectTask(null)}><X aria-hidden="true" /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 pb-4 pt-5">
        <p className="break-all font-mono text-[10px] tracking-[0.1em] text-primary">{task.agentName} / {task.runtime}</p>
        <h3 className="mt-2 break-words text-base font-semibold leading-snug">{task.title}</h3>
        <div className="mt-3 flex items-center justify-between gap-2"><TaskStatus status={task.status} text={text} /><span className="font-mono text-[10px] text-muted-foreground">r{task.revision}</span></div>
        <p className="mt-2 break-all font-mono text-[9px] leading-relaxed text-muted-foreground" data-testid="agent-task-id">{task.id}</p>
        {task.error && <p role="alert" data-testid="agent-task-failure" className="mt-3 whitespace-pre-wrap break-words rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">{task.error}</p>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-y border-border bg-surface-soft/50 px-5 py-3 text-[11px]">
        <dt className="text-muted-foreground">{text('cwd')}</dt><dd className="break-all font-mono text-ink-2">{task.cwd || '—'}</dd>
        <dt className="text-muted-foreground">{text('created')}</dt><dd className="text-ink-2">{formatDate(task.createdAt)}</dd>
        <dt className="text-muted-foreground">{text('updated')}</dt><dd className="text-ink-2">{formatDate(task.updatedAt)}</dd>
        {task.missionId && <><dt className="text-muted-foreground">{text('mission')}</dt><dd className="break-all font-mono text-ink-2">{task.missionId}</dd></>}
      </dl>
      <details className="border-b border-border px-5 py-3" open>
        <summary className="cursor-pointer rounded text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">{text('prompt')}</summary>
        <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-2" data-testid="agent-task-original-prompt">{task.prompt}</p>
      </details>
      {related.length > 0 && <div className="border-b border-border px-5 py-3">
        <h4 className="mb-2 text-[11px] font-medium text-muted-foreground">{text('relationships')}</h4>
        <div className="grid gap-1">{related.map((id) => {
          const other = tasks.find((candidate) => candidate.id === id)
          return <button key={id} type="button" data-testid="agent-task-relation" onClick={() => selectTask(id)} className="flex items-center gap-1.5 rounded py-1 text-left text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"><ArrowLeft aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">{other?.title ?? id}</span><span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{text(task.resumeOf === id ? 'resumedFrom' : task.parentTaskId === id ? 'parentTask' : 'dependsOn')}</span></button>
        })}</div>
      </div>}
      {approval && <section aria-labelledby="agent-approval-heading" data-testid="agent-task-approval" className="m-4 rounded-lg border border-primary/30 bg-accent-soft p-3">
        <h4 id="agent-approval-heading" className="flex items-center gap-1.5 text-xs font-semibold text-foreground"><Pause aria-hidden="true" className="size-3.5 text-primary" />{text('approval')}</h4>
        <pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface p-2.5 font-mono text-[11px] leading-relaxed" data-testid="agent-approval-command">{approval.command}</pre>
        <p className={cn('mb-3 text-[10px]', expired ? 'text-destructive' : 'text-muted-foreground')}>{expired ? text('expired') : `${text('expires')} ${formatDate(approval.expiresAt)}`}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" data-testid="agent-task-approve" disabled={busy || expired} onClick={() => void act('approve', true)}><Check aria-hidden="true" />{text('approve')}</Button><Button type="button" size="sm" variant="outline" data-testid="agent-task-deny" disabled={busy || expired} onClick={() => void act('approve', false)}>{text('deny')}</Button></div>
      </section>}
      <section className="px-5 py-4" aria-labelledby="agent-output-heading">
        <div className="mb-3 flex items-center gap-2"><h4 id="agent-output-heading" className="text-xs font-semibold">{text('output')}</h4><span className="h-px flex-1 bg-border" /></div>
        <pre ref={output} data-testid="agent-task-output" aria-label={text('output')} tabIndex={0} className="max-h-[50dvh] min-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-soft/60 p-3 font-mono text-[11px] leading-[1.8] text-ink-2 focus-visible:outline-2 focus-visible:outline-ring" onScroll={(event) => {
          const element = event.currentTarget
          followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        }}>{task.output || <span className="font-sans text-muted-foreground">{text('noOutput')}</span>}</pre>
      </section>
      {nextTasks.length > 0 && <div className="border-t border-border px-5 py-3"><h4 className="mb-2 text-[11px] font-medium text-muted-foreground">{text('children')}</h4>{nextTasks.map((next) => <button key={next.id} type="button" data-testid="agent-task-followup-link" className="flex w-full items-center gap-2 rounded py-1.5 text-left text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => selectTask(next.id)}><ArrowUpRight className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{next.title}</span></button>)}</div>}
    </div>
    <div className="border-t border-border bg-surface px-4 py-3">
      {active ? <><Button type="button" variant="outline" className="w-full text-destructive motion-reduce:transition-none" data-testid="agent-task-stop" disabled={busy} onClick={() => void act('stop')}><Square aria-hidden="true" className="size-3" />{text('stop')}</Button><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{text('handoffFirstStop')}</p></> : <div className="grid grid-cols-2 gap-2"><Button type="button" size="sm" data-testid="agent-task-continue" disabled={busy} onClick={() => onFollowup({ kind: 'continue', task })}>{text('continue')}</Button><Button type="button" size="sm" variant="outline" data-testid="agent-task-handoff" disabled={busy} onClick={() => onFollowup({ kind: 'handoff', task })}>{text('handoff')}</Button></div>}
    </div>
  </aside>
}
