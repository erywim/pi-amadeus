import * as React from 'react'
import { useState } from 'react'
import { Bot, Languages, MonitorCog, Send, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { AiPanel } from './AiPanel'
import { FeishuPanel } from './FeishuPanel'
import { GeneralPanel } from './GeneralPanel'
import { LanguagePanel } from './LanguagePanel'
import { SkillsPanel } from './SkillsPanel'

type Section = 'ai' | 'feishu' | 'skills' | 'language' | 'general'

/** 设置页（原型布局）：左侧分类导航 + 右侧面板（max-w 居中） */
export default function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<Section>('ai')

  const items: Array<{ key: Section; icon: LucideIcon; label: string }> = [
    { key: 'ai', icon: Bot, label: t('settings.nav.ai') },
    { key: 'feishu', icon: Send, label: t('settings.nav.feishu') },
    { key: 'skills', icon: Sparkles, label: t('settings.nav.skills') },
    { key: 'language', icon: Languages, label: t('settings.nav.language') },
    { key: 'general', icon: MonitorCog, label: t('settings.nav.general') }
  ]

  return (
    <div className="flex h-full min-h-0 flex-1 bg-background">
      <nav className="w-[216px] shrink-0 space-y-0.5 border-r border-border p-3 pt-6">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={section === item.key ? 'page' : undefined}
            onClick={() => setSection(item.key)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-[10px] px-3 py-[9px] text-left text-[15px] text-ink-2 transition-colors hover:bg-surface-soft',
              section === item.key &&
                'bg-surface font-semibold text-foreground shadow-[inset_0_0_0_1px_var(--border)]'
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 pb-8 pt-7">
          {section === 'ai' && <AiPanel />}
          {section === 'feishu' && <FeishuPanel />}
          {section === 'skills' && <SkillsPanel />}
          {section === 'language' && <LanguagePanel />}
          {section === 'general' && <GeneralPanel />}
        </div>
      </div>
    </div>
  )
}
