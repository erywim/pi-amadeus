import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

type BadgeProps = React.ComponentPropsWithRef<'div'> & VariantProps<typeof badgeVariants>

function Badge({ ref, className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
