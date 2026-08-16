import * as React from 'react'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore, type UiLanguage } from '@renderer/stores/settingsStore'

/** 界面语言切换：即时生效 + localStorage 持久 */
export function LanguagePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)

  const options: Array<{ value: UiLanguage; label: string }> = [
    { value: 'zh', label: t('settings.language.zh') },
    { value: 'en', label: t('settings.language.en') },
    { value: 'ja', label: t('settings.language.ja') }
  ]

  return (
    <div className="max-w-md">
      <h2 className="text-base font-semibold">{t('settings.language.title')}</h2>
      <p className="mb-6 mt-1 text-xs text-muted-foreground">{t('settings.language.desc')}</p>
      <div className="space-y-3">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setLanguage(option.value)}
            className={cn(
              'flex w-full items-center justify-between rounded-md border px-4 py-3 text-sm transition-colors',
              language === option.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {option.label}
            {language === option.value && <Check className="size-4" />}
          </button>
        ))}
      </div>
    </div>
  )
}
