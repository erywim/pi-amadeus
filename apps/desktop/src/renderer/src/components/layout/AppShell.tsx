import * as React from 'react'
import { History, MessageSquareText, PersonStanding, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet } from 'react-router'
import { Avatar, AvatarFallback } from '@renderer/components/ui/avatar'
import { useUiStore } from '@renderer/stores/uiStore'
import { RailItem } from './RailItem'

/** 52px 图标导航栏 + 内容区（Outlet）。Live2D 页不在此壳内，全屏独立路由 */
export default function AppShell(): React.JSX.Element {
  const { t } = useTranslation()
  const username = useUiStore((s) => s.username)

  return (
    <div className="flex h-screen">
      <nav className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2">
        <Link
          to="/chat"
          title="Amadeus"
          className="mb-2 flex size-11 items-center justify-center rounded-lg bg-primary/10 font-mono text-lg font-bold text-primary text-glow-cyan transition-colors hover:bg-primary/20"
        >
          A
        </Link>
        <RailItem to="/chat" icon={MessageSquareText} label={t('nav.sessions')} />
        <RailItem to="/history" icon={History} label={t('nav.history')} />
        <RailItem to="/settings" icon={Settings} label={t('nav.settings')} />
        <div className="flex-1" />
        <RailItem to="/live2d" icon={PersonStanding} label={t('nav.live2d')} />
        <Avatar className="mt-1 size-9 border border-border">
          <AvatarFallback className="bg-accent font-mono text-xs text-muted-foreground">
            {username ? username.charAt(0).toUpperCase() : 'A'}
          </AvatarFallback>
        </Avatar>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  )
}
