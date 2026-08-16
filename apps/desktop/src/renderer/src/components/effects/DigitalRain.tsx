import * as React from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '@renderer/lib/utils'

// 片假名 + 数字符号，命运石之门登录屏风味
const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789:;+-*/=<>$#@'

const FONT_SIZE = 16

/** 数字雨（Matrix 风格，绿色荧光，登录覆盖层背景） */
export function DigitalRain({ className }: { className?: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    let columns = 0
    let drops: number[] = []

    // 箭头函数在守卫之后创建，TS 能把 canvas/ctx 的收窄带进闭包
    const resize = (): void => {
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width
      canvas.height = height
      columns = Math.ceil(width / FONT_SIZE)
      drops = Array.from({ length: columns }, () => Math.random() * -(height / FONT_SIZE))
    }

    const frame = (): void => {
      // 拖尾：半透明黑覆盖
      ctx.fillStyle = 'rgba(0, 0, 0, 0.10)'
      ctx.fillRect(0, 0, width, height)
      ctx.font = `${FONT_SIZE}px Consolas, 'Courier New', monospace`
      for (let i = 0; i < columns; i++) {
        const y = drops[i]! * FONT_SIZE
        if (y < height && y > 0) {
          // 头部字符更亮
          const isHead = Math.random() > 0.5
          ctx.fillStyle = isHead ? 'rgba(168, 255, 203, 0.9)' : 'rgba(0, 255, 102, 0.55)'
          ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)]!, i * FONT_SIZE, y)
        }
        if (y > height && Math.random() > 0.975) {
          drops[i] = Math.random() * -(height / FONT_SIZE)
        }
        drops[i] = drops[i]! + 1
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
