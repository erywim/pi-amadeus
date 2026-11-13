import * as React from 'react'
import { GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { laneColorFor } from './helpers'

interface LaneNode {
  key: string
  role: 'user' | 'assistant' | 'live' | 'error' | 'empty'
  /** 该条助手消息对应的工具调用次数（只有当前会话能拿到） */
  toolCount?: number
  title: string
}

const MAX_LANES = 10
const MAX_NODES = 12

/**
 * 会话运行图（Lancer GitTree 的等价物）：
 * 每个会话一条泳道，节点来自真实消息；当前会话用已加载的消息逐条绘制，
 * 其它会话按服务端返回的消息数绘制（不伪造消息内容）。
 * 流式进行中的泳道会点亮流光与脉冲节点。
 */
export function RunGraph(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) =>
    s.activeSessionId ? (s.messages[s.activeSessionId] ?? []) : []
  )
  const stream = useSessionStore((s) => s.stream)
  const workLogs = useSessionStore((s) => s.workLogs)
  const turnErrors = useSessionStore((s) => s.turnErrors)
  const selectSession = useSessionStore((s) => s.selectSession)

  const lanes = sessions.slice(0, MAX_LANES)
  const streamingHere = stream.streaming && stream.sessionId === activeSessionId

  if (lanes.length === 0) {
    return (
      <div data-testid="run-graph" className="flex h-full flex-col">
        <GraphHeader count={0} />
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <GitBranch className="mx-auto size-5 text-muted-foreground/60" strokeWidth={1.6} />
            <p className="mt-2 text-[12.5px] text-muted-foreground">{t('workbench.graph.empty')}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground/80">
              {t('workbench.graph.emptyHint')}
            </p>
          </div>
        </div>
        <GraphLegend />
      </div>
    )
  }

  return (
    <div data-testid="run-graph" className="flex h-full min-h-0 flex-col">
      <GraphHeader count={lanes.length} />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="relative flex min-w-max gap-0.5 px-3 pb-1 pt-1">
          {lanes.length > 1 && (
            <div
              aria-hidden
              className="absolute left-5 right-5 top-[14px] h-px bg-border"
            />
          )}
          {lanes.map((session) => {
            const isActive = session.id === activeSessionId
            const color = laneColorFor(session.id)
            const nodes = nodesOf({
              isActive,
              sessionId: session.id,
              messageCount: session.messageCount ?? 0,
              messages: isActive ? messages : [],
              workLogs,
              streaming: isActive && streamingHere,
              error: isActive && Boolean(turnErrors[session.id]) && !streamingHere
            })
            const turns = Math.max(
              1,
              Math.ceil((isActive && messages.length > 0 ? messages.length : session.messageCount ?? 0) / 2)
            )
            return (
              <div
                key={session.id}
                data-testid="run-lane"
                data-session-id={session.id}
                data-active={isActive ? 'true' : 'false'}
                className="flex w-[88px] shrink-0 flex-col"
                style={{ '--lane-color': color } as React.CSSProperties}
              >
                <button
                  type="button"
                  onClick={() => selectSession(session.id)}
                  title={session.title || session.id}
                  className="relative z-10 flex h-[46px] flex-col items-center gap-1 px-1 text-center"
                >
                  <span
                    className={cn(
                      'mt-[10px] size-[6px] shrink-0 rounded-full',
                      isActive && 'ring-2 ring-primary/20 ring-offset-1'
                    )}
                    style={{ background: isActive ? color : 'var(--lane-line)' }}
                  />
                  <span
                    className={cn(
                      'line-clamp-2 text-[10.5px] leading-[1.2]',
                      isActive ? 'font-semibold text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {session.title || t('codex.untitledTask')}
                  </span>
                </button>

                <div className="relative flex flex-1 flex-col items-center pb-2">
                  <span
                    aria-hidden
                    className={cn(
                      'absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2',
                      isActive && streamingHere ? 'lancer-track-live' : 'bg-border'
                    )}
                  />
                  {nodes.items.map((node) => (
                    <button
                      key={node.key}
                      type="button"
                      data-testid="run-node"
                      data-role={node.role}
                      title={node.title}
                      onClick={() => selectSession(session.id)}
                      className="relative z-10 flex h-7 w-full items-center justify-center gap-[3px]"
                    >
                      <NodeDot role={node.role} color={color} />
                      {node.role === 'assistant' && (node.toolCount ?? 0) > 0 && (
                        <span className="flex flex-col gap-[2px]">
                          {Array.from({ length: Math.min(3, node.toolCount ?? 0) }).map((_, index) => (
                            <span
                              key={index}
                              className="size-[3px] rounded-full bg-amber-sg"
                              title={t('workbench.graph.legendTool')}
                            />
                          ))}
                        </span>
                      )}
                    </button>
                  ))}
                  {nodes.more > 0 && (
                    <span className="relative z-10 font-mono text-[9px] text-muted-foreground">
                      {t('workbench.graph.more', { count: nodes.more })}
                    </span>
                  )}
                  <span className="relative z-10 mt-auto pt-2 font-mono text-[9.5px] text-muted-foreground/80">
                    {t('workbench.graph.turns', { count: turns })}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <p className="px-4 pb-2 text-[10px] leading-relaxed text-muted-foreground/80">
          {t('workbench.graph.historyHint')}
        </p>
      </div>

      <GraphLegend />
    </div>
  )
}

function GraphHeader({ count }: { count: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border px-4">
      <GitBranch className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
      <div className="min-w-0">
        <p className="text-[12px] font-semibold leading-tight">{t('workbench.graph.title')}</p>
        <p className="truncate text-[10px] leading-tight text-muted-foreground">
          {t('workbench.graph.subtitle')}
        </p>
      </div>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{count}</span>
    </div>
  )
}

function GraphLegend(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
      <LegendItem label={t('workbench.graph.legendUser')}>
        <span className="size-[7px] rounded-full border-[1.5px] border-muted-foreground bg-surface" />
      </LegendItem>
      <LegendItem label={t('workbench.graph.legendAssistant')}>
        <span className="size-[7px] rounded-full bg-mint" />
      </LegendItem>
      <LegendItem label={t('workbench.graph.legendTool')}>
        <span className="size-[3px] rounded-full bg-amber-sg" />
      </LegendItem>
      <LegendItem label={t('workbench.graph.legendLive')}>
        <span className="size-[7px] rounded-full bg-primary" />
      </LegendItem>
    </div>
  )
}

function LegendItem({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {label}
    </span>
  )
}

function NodeDot({
  role,
  color
}: {
  role: LaneNode['role']
  color: string
}): React.JSX.Element {
  if (role === 'user') {
    return (
      <span
        className="size-[7px] rounded-full border-[1.5px] bg-surface"
        style={{ borderColor: color }}
      />
    )
  }
  if (role === 'live') {
    return (
      <span
        className="lancer-live-node size-[8px] rounded-full"
        style={{ background: color, '--lane-color': color } as React.CSSProperties}
      />
    )
  }
  if (role === 'error') {
    return <span className="size-[7px] rounded-full bg-destructive" />
  }
  if (role === 'empty') {
    return <span className="size-[7px] rounded-full border border-dashed border-muted-foreground/60" />
  }
  return <span className="size-[7px] rounded-full" style={{ background: color }} />
}

function nodesOf(input: {
  isActive: boolean
  sessionId: string
  messageCount: number
  messages: { id: string; role: 'user' | 'assistant'; content: string }[]
  workLogs: Record<string, { tools: { toolName: string }[] }>
  streaming: boolean
  error: boolean
}): { items: LaneNode[]; more: number } {
  const items: LaneNode[] = []
  if (input.isActive && input.messages.length > 0) {
    for (const message of input.messages) {
      const toolCount = input.workLogs[message.id]?.tools.length ?? 0
      items.push({
        key: message.id,
        role: message.role,
        toolCount,
        title: `${message.role === 'user' ? '用户' : '助手'} · ${message.content.slice(0, 24)}`
      })
    }
    if (input.streaming) {
      items.push({ key: 'live', role: 'live', title: '运行中' })
    }
    if (input.error) {
      items.push({ key: 'error', role: 'error', title: '回合失败' })
    }
  } else {
    const turns = Math.max(0, Math.ceil(input.messageCount / 2))
    if (turns === 0) {
      items.push({ key: 'empty', role: 'empty', title: '还没有消息' })
    }
    const shown = Math.min(turns, Math.floor(MAX_NODES / 2))
    for (let index = 0; index < shown; index += 1) {
      items.push({ key: `u${index}`, role: 'user', title: `第 ${index + 1} 轮 · 用户` })
      items.push({ key: `a${index}`, role: 'assistant', title: `第 ${index + 1} 轮 · 助手` })
    }
  }
  // 超出上限时保留最近的节点：进行中节点和失败节点必须可见
  if (items.length > MAX_NODES) {
    return { items: items.slice(-MAX_NODES), more: items.length - MAX_NODES }
  }
  return { items, more: 0 }
}
