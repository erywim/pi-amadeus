import * as React from 'react'
import { useState } from 'react'
import { Bot, Languages, Send, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { AiPanel } from './AiPanel'
import { FeishuPanel } from './FeishuPanel'
import { LanguagePanel } from './LanguagePanel'
import { SkillsPanel } from './SkillsPanel'

type Section = 'ai' | 'feishu' | 'skills' | 'language'

/** 设置页：220px 分类导航 + 右侧面板 */
export default function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<Section>('ai')

  const items: Array<{ key: Section; icon: LucideIcon; label: string }> = [
    { key: 'ai', icon: Bot, label: t('settings.nav.ai') },
    { key: 'feishu', icon: Send, label: t('settings.nav.feishu') },
    { key: 'skills', icon: Sparkles, label: t('settings.nav.skills') },
    { key: 'language', icon: Languages, label: t('settings.nav.language') }
  ]

  return (
    <div className="flex h-full min-h-0 flex-1">
      <nav className="w-[220px] shrink-0 space-y-1 border-r border-border bg-sidebar p-3">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSection(item.key)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
              section === item.key
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {section === 'ai' && <AiPanel />}
        {section === 'feishu' && <FeishuPanel />}
        {section === 'skills' && <SkillsPanel />}
        {section === 'language' && <LanguagePanel />}
      </div>
    </div>
  )
}
