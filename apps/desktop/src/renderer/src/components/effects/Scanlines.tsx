import * as React from 'react'
import { cn } from '@renderer/lib/utils'

/** CRT 扫描线覆盖层（样式定义见 styles/index.css .crt-scanlines） */
export function Scanlines({ className }: { className?: string }): React.JSX.Element {
  return <div aria-hidden className={cn('crt-scanlines pointer-events-none absolute inset-0 z-20', className)} />
}
