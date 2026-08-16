import * as React from 'react'
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { cn } from '@renderer/lib/utils'

function Avatar({ ref, className, ...props }: React.ComponentPropsWithRef<typeof AvatarPrimitive.Root>): React.JSX.Element {
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn('relative flex size-10 shrink-0 overflow-hidden rounded-full', className)}
      {...props}
    />
  )
}

function AvatarImage({ ref, className, ...props }: React.ComponentPropsWithRef<typeof AvatarPrimitive.Image>): React.JSX.Element {
  return <AvatarPrimitive.Image ref={ref} className={cn('aspect-square size-full', className)} {...props} />
}

function AvatarFallback({ ref, className, ...props }: React.ComponentPropsWithRef<typeof AvatarPrimitive.Fallback>): React.JSX.Element {
  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn('flex size-full items-center justify-center rounded-full bg-muted', className)}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
