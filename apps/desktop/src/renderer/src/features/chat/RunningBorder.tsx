import * as React from 'react'

/**
 * 运行中的流动边框（细窄的流动描边）：
 * 只在流式进行时挂到气泡上，回合结束即卸载；
 * 用 SVG pathLength 做一圈虚线，避免整块背景发光。
 */
export function RunningBorder({ color }: { color?: string }): React.JSX.Element {
  return (
    <svg
      data-testid="running-border"
      className="agent-running-border"
      style={color ? ({ '--light-color': color } as React.CSSProperties) : undefined}
      aria-hidden
    >
      <rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="12" pathLength="100" />
    </svg>
  )
}
