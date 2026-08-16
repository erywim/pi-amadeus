import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'

/** 飞书绑定面板：M1 mock（本地开关切换绑定态 + 静态绑定码） */
export function FeishuPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [bound, setBound] = useState(false)

  return (
    <div className="max-w-xl">
      <h2 className="text-base font-semibold">{t('settings.feishu.title')}</h2>
      <p className="mb-6 mt-1 text-xs text-muted-foreground">{t('settings.feishu.desc')}</p>
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3">
          <span className="text-sm">{t('settings.feishu.status')}</span>
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={cn(
                'border',
                bound ? 'border-terminal-green/50 text-terminal-green' : 'border-amber-sg/50 text-amber-sg'
              )}
            >
              {bound ? t('settings.feishu.bound') : t('settings.feishu.unbound')}
            </Badge>
            <Switch checked={bound} onCheckedChange={setBound} />
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-sm">{t('settings.feishu.bindCode')}</div>
          <div className="inline-flex items-center gap-2 rounded-md border border-border bg-black/40 px-4 py-2 font-mono text-sm tracking-[0.2em] text-cyber-cyan">
            AMADEUS-7291
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('settings.feishu.hint')}</p>
        </div>
      </div>
    </div>
  )
}
