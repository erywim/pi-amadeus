import * as React from 'react'
import { memo, useRef } from 'react'
import { ArrowUpRight, Check, Circle, Grip, Pause, Square } from 'lucide-react'
import toast from 'react-hot-toast'
import type { AgentTask, AgentTaskStatus } from '@pi-amadeus/shared'
import { AgentApiError } from '@renderer/lib/agentApi'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agentStore'
import { useAgentText, type AgentText } from './translations'

const CARD_WIDTH = 236
const CARD_HEIGHT = 158
const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const colors: Record<AgentTaskStatus, string> = {
  queued: 'text-muted-foreground', running: 'text-primary', waiting_approval: 'text-amber-700 dark:text-amber-400',
  completed: 'text-mint', failed: 'text-destructive', cancelled: 'text-muted-foreground', interrupted: 'text-destructive'
}

export function TaskStatus({ status, text }: { status: AgentTaskStatus; text: AgentText }): React.JSX.Element {
  const Icon = status === 'completed' ? Check : status === 'waiting_approval' ? Pause : status === 'cancelled' ? Square : Circle
  return <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', colors[status])} data-testid="agent-task-status" data-status={status}>
    <Icon className={cn('size-3 shrink-0', status === 'running' && 'fill-current motion-safe:animate-pulse')} aria-hidden="true" />{text(`status.${status}`)}
  </span>
}

const TaskCard = memo(function TaskCard({ task, selected, canvas, text }: {
  task: AgentTask; selected: boolean; canvas: boolean; text: AgentText
}): React.JSX.Element {
  const selectTask = useAgentStore((state) => state.selectTask)
  const moveTask = useAgentStore((state) => state.moveTask)
  const busy = useAgentStore((state) => state.busyTasks[task.id] ?? false)
  const button = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; task: AgentTask; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const saving = useRef(false)

  function restorePosition(): void {
    const current = useAgentStore.getState().tasks.find((item) => item.id === task.id) ?? task
    if (button.current) button.current.style.transform = `translate(${current.position.x}px, ${current.position.y}px)`
  }

  async function persist(original: AgentTask, position: AgentTask['position']): Promise<void> {
    if (saving.current) return
    saving.current = true
    try {
      await moveTask(original, position)
    } catch (error) {
      toast.error(error instanceof AgentApiError && error.status === 409 ? text('conflict') : error instanceof Error ? error.message : String(error))
    } finally {
      saving.current = false
      // 成功或冲突都回到最新服务端坐标；失败不能把未保存的位置伪装成持久化。
      restorePosition()
    }
  }

  function dragPosition(event: React.PointerEvent<HTMLButtonElement>): AgentTask['position'] {
    const current = drag.current
    if (!current) return task.position
    return {
      x: Math.max(0, Math.round(current.task.position.x + event.clientX - current.x)),
      y: Math.max(0, Math.round(current.task.position.y + event.clientY - current.y))
    }
  }

  return <button
    ref={button}
    type="button"
    data-testid="agent-task-card"
    data-task-id={task.id}
    data-revision={task.revision}
    aria-pressed={selected}
    aria-describedby={canvas ? 'agent-canvas-help' : undefined}
    className={cn(
      'group block overflow-hidden rounded-lg border bg-surface p-3.5 text-left motion-safe:transition-[box-shadow,border-color] motion-safe:duration-150', focusClass,
      selected ? 'z-10 border-primary shadow-sm ring-1 ring-primary/20' : 'border-border hover:border-primary/40 hover:shadow-sm',
      canvas ? 'absolute left-0 top-0 touch-none select-none' : 'w-full',
      canvas && !busy && 'cursor-grab active:cursor-grabbing', busy && 'cursor-progress'
    )}
    style={canvas ? { width: CARD_WIDTH, height: CARD_HEIGHT, transform: `translate(${task.position.x}px, ${task.position.y}px)` } : undefined}
    onClick={() => {
      if (suppressClick.current) { suppressClick.current = false; return }
      selectTask(task.id)
    }}
    onPointerDown={canvas ? (event) => {
      if (event.button !== 0 || !event.isPrimary || busy || saving.current) return
      suppressClick.current = false
      // 指针捕获保证拖出卡片仍收到释放；移动期间只改 DOM，不触发网络或 React 渲染。
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, task, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
    } : undefined}
    onPointerMove={canvas ? (event) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4 && !current.moved) return
      current.moved = true
      const position = dragPosition(event)
      event.currentTarget.style.transform = `translate(${position.x}px, ${position.y}px)`
    } : undefined}
    onPointerUp={canvas ? (event) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      const position = dragPosition(event)
      drag.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      if (current.moved) {
        // 松手才保存起拖时的 revision；并发冲突由服务端 409 决定，不覆盖他人移动。
        suppressClick.current = true
        void persist(current.task, position)
      }
    } : undefined}
    onPointerCancel={canvas ? () => { drag.current = null; restorePosition() } : undefined}
    onLostPointerCapture={canvas ? () => { if (drag.current) { drag.current = null; restorePosition() } } : undefined}
    onKeyDown={canvas ? (event) => {
      const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      const delta = directions[event.key]
      if (!delta) return
      event.preventDefault()
      if (busy || saving.current) return
      const step = event.shiftKey ? 64 : 16
      const position = { x: Math.max(0, task.position.x + delta[0] * step), y: Math.max(0, task.position.y + delta[1] * step) }
      if (position.x === task.position.x && position.y === task.position.y) return
      event.currentTarget.style.transform = `translate(${position.x}px, ${position.y}px)`
      void persist(task, position)
    } : undefined}
  >
    <span className="mb-3 flex items-center justify-between gap-2">
      <span className="min-w-0 truncate font-mono text-[10px] tracking-[0.08em] text-muted-foreground">{task.agentName} / {task.id.slice(0, 6)}</span>
      {canvas ? <Grip className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" /> : <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden="true" />}
    </span>
    <span className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-foreground">{task.title}</span>
    <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{task.cwd || task.runtime}</span>
    <span className={cn('mt-3 flex items-center justify-between gap-1', canvas && 'absolute bottom-3 left-3.5 right-3.5')}>
      <TaskStatus status={task.status} text={text} />
      {(task.dependsOn.length > 0 || task.resumeOf) && <span className="text-[10px] text-muted-foreground">{task.resumeOf ? '↳' : '↗'} {task.dependsOn.length || 1}</span>}
    </span>
  </button>
})

/** HTML 折线仅投影已存在的依赖/续接关系，不创建新的执行顺序。 */
function TaskLinks({ tasks }: { tasks: AgentTask[] }): React.JSX.Element {
  const index = new Map(tasks.map((task) => [task.id, task]))
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0">
    {tasks.flatMap((target) => {
      const sources = [...new Set([...target.dependsOn, ...(target.resumeOf ? [target.resumeOf] : []), ...(target.parentTaskId ? [target.parentTaskId] : [])])]
      return sources.map((id) => {
        const source = index.get(id)
        if (!source || source.id === target.id) return null
        const x1 = source.position.x + CARD_WIDTH
        const y1 = source.position.y + CARD_HEIGHT / 2
        const x2 = target.position.x
        const y2 = target.position.y + CARD_HEIGHT / 2
        const middle = (x1 + x2) / 2
        return <React.Fragment key={`${id}-${target.id}`}>
          <span className="absolute border-t border-primary/30" style={{ left: Math.min(x1, middle), top: y1, width: Math.abs(middle - x1) }} />
          <span className="absolute border-l border-primary/30" style={{ left: middle, top: Math.min(y1, y2), height: Math.abs(y2 - y1) }} />
          <span className="absolute border-t border-primary/30" style={{ left: Math.min(middle, x2), top: y2, width: Math.abs(x2 - middle) }} />
          <span className="absolute size-1.5 rounded-full bg-primary/50" style={{ left: x2 - 3, top: y2 - 3 }} />
        </React.Fragment>
      })
    })}
  </div>
}

export function TaskBoard({ tasks, selectedId, view }: { tasks: AgentTask[]; selectedId: string | null; view: 'canvas' | 'list' }): React.JSX.Element {
  const text = useAgentText()
  if (view === 'list') return <div data-testid="agent-task-list" className="grid content-start gap-2 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-1">{tasks.map((task) => <TaskCard key={task.id} task={task} selected={task.id === selectedId} canvas={false} text={text} />)}</div>
  const width = Math.max(680, ...tasks.map((task) => task.position.x + CARD_WIDTH + 48))
  const height = Math.max(460, ...tasks.map((task) => task.position.y + CARD_HEIGHT + 48))
  return <div data-testid="agent-task-canvas" className="min-h-[350px] flex-1 overflow-auto overscroll-contain bg-stage/40">
    <div className="relative m-6 bg-[radial-gradient(var(--line-strong)_1px,transparent_1px)] bg-[size:20px_20px]" style={{ width, height }}>
      <TaskLinks tasks={tasks} />
      {tasks.map((task) => <TaskCard key={task.id} task={task} selected={task.id === selectedId} canvas text={text} />)}
    </div>
  </div>
}
