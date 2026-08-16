import * as React from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '@renderer/lib/utils'

interface Particle {
  x: number
  y: number
  r: number
  speed: number
  drift: number
  alpha: number
  color: string
}

const COLORS = ['rgba(0,229,255,', 'rgba(0,255,102,', 'rgba(0,184,212,']

/** Live2D 场景背景：缓慢上浮的青色/绿色光点 */
export function ParticleBackground({ className }: { className?: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    let particles: Particle[] = []

    const spawn = (): Particle => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() * 1.6 + 0.6,
      speed: Math.random() * 0.35 + 0.08,
      drift: Math.random() * 0.4 - 0.2,
      alpha: Math.random() * 0.5 + 0.15,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!
    })

    // 箭头函数在守卫之后创建，TS 能把 canvas/ctx 的收窄带进闭包
    const resize = (): void => {
      width = canvas.clientWidth
      height = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.min(80, Math.max(24, Math.floor((width * height) / 18000)))
      particles = Array.from({ length: count }, () => spawn())
    }

    const frame = (): void => {
      ctx.clearRect(0, 0, width, height)
      for (const p of particles) {
        p.y -= p.speed
        p.x += p.drift
        if (p.y < -10) {
          p.y = height + 10
          p.x = Math.random() * width
        }
        if (p.x < -10) p.x = width + 10
        if (p.x > width + 10) p.x = -10
        ctx.beginPath()
        ctx.fillStyle = `${p.color}${p.alpha})`
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      raf = requestAnimationFrame(frame)
    }

    resize()
    frame()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden className={cn('absolute inset-0', className)} />
}
