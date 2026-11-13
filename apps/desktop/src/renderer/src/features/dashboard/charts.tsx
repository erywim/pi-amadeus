import * as React from 'react'
import { useId } from 'react'

/** 轻量图表：只用 SVG/CSS，不引图表库；颜色全部走主题变量 */

export function BarChart({
  data,
  height = 120
}: {
  data: { label: string; value: number }[]
  height?: number
}): React.JSX.Element {
  const max = Math.max(1, ...data.map((point) => point.value))
  return (
    <div className="flex items-end gap-1" style={{ height }} role="img">
      {data.map((point) => (
        <div key={point.label} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {point.value}
          </span>
          <div
            className="w-full max-w-6 rounded-t-[3px] bg-primary/80 transition-colors group-hover:bg-primary"
            style={{ height: `${Math.max(2, (point.value / max) * (height - 26))}px` }}
            title={`${point.label}: ${point.value}`}
          />
          <span className="truncate text-[9.5px] text-muted-foreground">{point.label}</span>
        </div>
      ))}
    </div>
  )
}

export function AreaChart({
  data,
  height = 120,
  color = 'var(--primary)'
}: {
  data: { label: string; value: number }[]
  height?: number
  color?: string
}): React.JSX.Element {
  const gradientId = `area-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const width = 320
  const pad = 6
  const max = Math.max(1, ...data.map((point) => point.value))
  const stepX = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0
  const points = data.map((point, index) => {
    const x = pad + index * stepX
    const y = height - pad - (point.value / max) * (height - pad * 2)
    return `${x},${y}`
  })
  const line = points.length > 0 ? `M${points.join(' L')}` : ''
  const area =
    points.length > 0
      ? `${line} L${pad + (data.length - 1) * stepX},${height - pad} L${pad},${height - pad} Z`
      : ''

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height }}
      role="img"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={ratio}
          x1={pad}
          x2={width - pad}
          y1={pad + (height - pad * 2) * ratio}
          y2={pad + (height - pad * 2) * ratio}
          stroke="var(--border)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
      ))}
      {area && <path d={area} fill={`url(#${gradientId})`} />}
      {line && <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />}
      {points.map((point, index) => {
        const [x, y] = point.split(',')
        return (
          <circle key={data[index]!.label} cx={x} cy={y} r="2.2" fill={color}>
            <title>{`${data[index]!.label}: ${data[index]!.value}`}</title>
          </circle>
        )
      })}
    </svg>
  )
}

const DONUT_COLORS = [
  'var(--primary)',
  'var(--mint)',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#64748b'
]

export function DonutChart({
  data,
  size = 120
}: {
  data: { label: string; value: number }[]
  size?: number
}): React.JSX.Element {
  const total = data.reduce((sum, item) => sum + item.value, 0)
  const radius = 42
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" className="shrink-0">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--border)" strokeWidth="14" />
        {total > 0 &&
          data.map((item, index) => {
            const length = (item.value / total) * circumference
            const dashOffset = -offset
            offset += length
            return (
              <circle
                key={item.label}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={DONUT_COLORS[index % DONUT_COLORS.length]}
                strokeWidth="14"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 50 50)"
              >
                <title>{`${item.label}: ${item.value}`}</title>
              </circle>
            )
          })}
        <text
          x="50"
          y="47"
          textAnchor="middle"
          className="fill-foreground"
          style={{ fontSize: 16, fontWeight: 600 }}
        >
          {total}
        </text>
        <text x="50" y="61" textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 8 }}>
          total
        </text>
      </svg>
      <div className="grid min-w-0 gap-1.5">
        {data.map((item, index) => (
          <div key={item.label} className="flex items-center gap-2 text-[12px]">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: DONUT_COLORS[index % DONUT_COLORS.length] }}
            />
            <span className="truncate text-ink-2">{item.label}</span>
            <span className="ml-auto text-muted-foreground">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function HBarList({
  items,
  emptyText
}: {
  items: { label: string; value: number }[]
  emptyText: string
}): React.JSX.Element {
  const max = Math.max(1, ...items.map((item) => item.value))
  if (items.length === 0) {
    return <p className="py-8 text-center text-[12.5px] text-muted-foreground">{emptyText}</p>
  }
  return (
    <div className="grid gap-2.5">
      {items.map((item) => (
        <div key={item.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-[11.5px] text-ink-2">{item.label}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${(item.value / max) * 100}%` }}
              />
            </div>
          </div>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{item.value}</span>
        </div>
      ))}
    </div>
  )
}
