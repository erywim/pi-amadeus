import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '@renderer/lib/utils'

function Label({
  ref,
  className,
  ...props
}: React.ComponentPropsWithRef<typeof LabelPrimitive.Root>): React.JSX.Element {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className
      )}
      {...props}
    />
  )
}

export { Label }
