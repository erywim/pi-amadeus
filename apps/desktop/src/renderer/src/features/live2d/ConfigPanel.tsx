import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@renderer/components/ui/label'
import { Separator } from '@renderer/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@renderer/components/ui/sheet'
import { Slider } from '@renderer/components/ui/slider'
import { cn } from '@renderer/lib/utils'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore } from '@renderer/stores/uiStore'

/** 左侧配置面板 Sheet：形象（缩放/位移滑块，实时生效并持久）+ AI（只读摘要） */
export function ConfigPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.configPanelOpen)
  const tab = useUiStore((s) => s.configPanelTab)
  const setConfigPanelOpen = useUiStore((s) => s.setConfigPanelOpen)
  const avatar = useLive2dStore((s) => s.avatar)
  const setAvatar = useLive2dStore((s) => s.setAvatar)
  const aiConfig = useSettingsStore((s) => s.aiConfig)
  const keyStatus = useSettingsStore((s) => s.keyStatus)

  const tabs: Array<{ key: 'avatar' | 'ai'; label: string }> = [
    { key: 'avatar', label: t('live2d.config.avatar') },
    { key: 'ai', label: t('live2d.config.ai') }
  ]

  return (
    <Sheet open={open} onOpenChange={(v) => setConfigPanelOpen(v)}>
      <SheetContent side="left" className="w-[320px] bg-sidebar sm:max-w-[320px]">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm tracking-[0.2em] text-primary">{t('live2d.config.title')}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex gap-1">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setConfigPanelOpen(true, item.key)}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs transition-colors',
                tab === item.key
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mt-5 space-y-5">
          {tab === 'avatar' ? (
            <>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label>{t('live2d.config.scale')}</Label>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{avatar.scale.toFixed(2)}</span>
                </div>
                <Slider
                  min={0.2}
                  max={1}
                  step={0.01}
                  value={[avatar.scale]}
                  onValueChange={(value) => {
                    const v = value[0]
                    if (v !== undefined) setAvatar({ scale: v })
                  }}
                />
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label>{t('live2d.config.positionX')}</Label>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{avatar.positionX}</span>
                </div>
                <Slider
                  min={-250}
                  max={250}
                  step={1}
                  value={[avatar.positionX]}
                  onValueChange={(value) => {
                    const v = value[0]
                    if (v !== undefined) setAvatar({ positionX: v })
                  }}
                />
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label>{t('live2d.config.positionY')}</Label>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{avatar.positionY}</span>
                </div>
                <Slider
                  min={-350}
                  max={350}
                  step={1}
                  value={[avatar.positionY]}
                  onValueChange={(value) => {
                    const v = value[0]
                    if (v !== undefined) setAvatar({ positionY: v })
                  }}
                />
              </div>
            </>
          ) : (
            <div className="space-y-3 text-xs">
              <div>
                <div className="mb-1 text-muted-foreground">{t('settings.ai.baseUrl')}</div>
                <div className="break-all font-mono text-foreground/90">{aiConfig.provider.baseUrl || '—'}</div>
              </div>
              <div>
                <div className="mb-1 text-muted-foreground">{t('settings.ai.model')}</div>
                <div className="font-mono text-foreground/90">{aiConfig.provider.model || '—'}</div>
              </div>
              {aiConfig.provider.proxy ? (
                <div>
                  <div className="mb-1 text-muted-foreground">{t('settings.ai.proxy')}</div>
                  <div className="break-all font-mono text-foreground/90">{aiConfig.provider.proxy}</div>
                </div>
              ) : null}
              <div>
                <div className="mb-1 text-muted-foreground">{t('settings.ai.apiKey')}</div>
                <div className="font-mono text-foreground/90">
                  {keyStatus === 'default'
                    ? t('settings.ai.keyDefault')
                    : keyStatus === 'custom'
                      ? t('settings.ai.keySaved')
                      : '—'}
                </div>
              </div>
              <Separator />
              <p className="leading-relaxed text-muted-foreground">{t('settings.ai.desc')}</p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
