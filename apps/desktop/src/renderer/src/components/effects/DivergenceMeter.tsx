import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { WORLD_LINES, useDivergenceStore } from '@renderer/stores/divergenceStore'

const ROLL_TICKS = 9
const ROLL_MS = 42

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 翻牌滚动：位数逐位锁定为目标世界线，未锁定位随机乱数 */
function scramble(target: string, fraction: number): string {
  const fixed = Math.floor(fraction * target.length)
  let out = ''
  for (let i = 0; i < target.length; i++) {
    out += i < fixed || target[i] === '.' ? target[i] : String(Math.floor(Math.random() * 10))
  }
  return out
}

/**
 * 世界线变动率计（陪伴舞台常驻设备）：深色蚀刻板 + DSEG7 辉光管数字，
 * 点击观测下一条世界线（固定序列轮询，读数与文本模式侧栏脚部共享）。
 */
export function DivergenceMeter(): React.JSX.Element {
  const value = useDivergenceStore((s) => s.value)
  const next = useDivergenceStore((s) => s.next)
  const [display, setDisplay] = useState(value)
  const rollingRef = useRef(false)

  useEffect(() => {
    if (value === display) return
    if (reducedMotion) {
      setDisplay(value)
      return
    }
    rollingRef.current = true
    let step = 0
    const timer = setInterval(() => {
      step += 1
      setDisplay(scramble(value, step / ROLL_TICKS))
      if (step >= ROLL_TICKS) {
        clearInterval(timer)
        setDisplay(value)
        rollingRef.current = false
      }
    }, ROLL_MS)
    return () => clearInterval(timer)
    // display 不加入依赖：value 落定后动画自身驱动 display 追赶
  }, [value])

  return (
    <button
      type="button"
      onClick={() => {
        if (!rollingRef.current) next()
      }}
      title={`当前世界线变动率 ${value}；在 ${WORLD_LINES.join(' / ')} 间观测`}
      aria-label={`当前世界线变动率 ${value}，点击观测下一条世界线`}
      className="pointer-events-auto grid justify-items-start gap-1 rounded-[3px] border border-lab-line bg-[rgba(10,12,17,0.78)] px-3.5 py-2.5 backdrop-blur-md transition-colors hover:border-lab-amber/55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lab-amber"
    >
      <span className="font-mono text-[9px] tracking-[0.34em] text-lab-ink/70">DIVERGENCE</span>
      <span
        className="font-digit text-[27px] leading-[1.1] tracking-[0.05em] text-lab-digit"
        style={{
          textShadow: '0 0 8px rgba(255,182,72,0.5), 0 0 26px rgba(255,152,40,0.22)'
        }}
      >
        {display}
      </span>
    </button>
  )
}
