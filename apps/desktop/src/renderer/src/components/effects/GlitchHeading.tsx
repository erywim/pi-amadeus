import * as React from 'react'
import { cn } from '@renderer/lib/utils'

interface GlitchHeadingProps {
  text: string
  className?: string
}

/** 命运石之门 glitch 标题：RGB 分裂 + 切片跳动，动画数轮后归于平静（定义见 styles/index.css） */
export function GlitchHeading({ text, className }: GlitchHeadingProps): React.JSX.Element {
  return (
    <h1
      data-text={text}
      className={cn(
        'glitch-title font-mono text-4xl font-bold tracking-[0.25em] text-primary text-glow-cyan',
        className
      )}
    >
      {text}
    </h1>
  )
}
