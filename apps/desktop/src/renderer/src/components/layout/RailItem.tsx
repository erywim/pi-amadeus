import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { NavLink } from 'react-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'

interface RailItemProps {
  to: string
  icon: LucideIcon
  label: string
}

/** 左侧 52px 图标导航栏的单项：NavLink + 右侧 tooltip */
export function RailItem({ to, icon: Icon, label }: RailItemProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={to}
          className={({ isActive }) =>
            cn(
              'flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors',
              'hover:bg-primary/10 hover:text-primary',
              isActive && 'bg-primary/15 text-primary shadow-[0_0_14px_rgba(0,229,255,0.2)]'
            )
          }
        >
          <Icon className="size-5" strokeWidth={1.75} />
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}
