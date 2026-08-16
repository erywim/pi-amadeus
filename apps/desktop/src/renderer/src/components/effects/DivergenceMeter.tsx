import * as React from 'react'
import { useEffect, useRef, useState } from 'react'

const ROLL_TICKS = 10
const ROLL_MS = 55

function nextValue(): string {
  return (0.2 + Math.random() * 1.1).toFixed(6)
}

/** 世界线变动率计：CRT 绿荧光数字 + 扫描线覆盖，点击滚动重掷 */
export function DivergenceMeter(): React.JSX.Element {
  const [value, setValue] = useState(() => nextValue())
  const [rolling, setRolling] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
    },
    []
  )

  function roll(): void {
    if (rolling) return
    setRolling(true)
    let ticks = 0
    timerRef.current = setInterval(() => {
      ticks += 1
      setValue(nextValue())
      if (ticks >= ROLL_TICKS) {
        if (timerRef.current !== null) clearInterval(timerRef.current)
        timerRef.current = null
        setRolling(false)
      }
    }, ROLL_MS)
  }

  return (
    <div className="relative w-[300px] overflow-hidden rounded-md border border-terminal-green-dim/40 bg-black/70 shadow-[0_0_32px_rgba(0,255,102,0.12)]">
      <div className="crt-scanlines absolute inset-0" aria-hidden />
      <button
        type="button"
        onClick={roll}
        title="点击重新校准"
        className="relative block w-full px-6 py-5 text-left transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-terminal-green"
      >
        <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.35em] text-terminal-green-dim">
          <span>Divergence</span>
          <span className="size-1.5 animate-pulse rounded-full bg-terminal-green" />
        </div>
        <span className="crt-flicker block font-mono text-[38px] font-bold leading-none tracking-[0.12em] tabular-nums text-terminal-green text-glow-green">
          {value}
        </span>
      </button>
    </div>
  )
}
