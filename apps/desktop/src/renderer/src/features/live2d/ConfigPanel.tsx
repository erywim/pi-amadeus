import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { EMOTIONS, GESTURES } from '@pi-amadeus/shared'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@renderer/components/ui/sheet'
import { Slider } from '@renderer/components/ui/slider'
import { cn } from '@renderer/lib/utils'
import { MODEL_IDS, MODEL_PROFILES, resolveModelId } from '@renderer/features/live2d/lib/models'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore, type ConfigPanelTab } from '@renderer/stores/uiStore'

/** 左侧配置面板 Sheet：形象（缩放/位移滑块，实时生效并持久）+ 表情预览 + AI（只读摘要） */
export function ConfigPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.configPanelOpen)
  const tab = useUiStore((s) => s.configPanelTab)
  const setConfigPanelOpen = useUiStore((s) => s.setConfigPanelOpen)
  const modelId = useLive2dStore((s) => s.modelId)
  const setModelId = useLive2dStore((s) => s.setModelId)
  // 摆位按模型各存一份：切模型时滑块显示的是该模型自己的值
  const avatar = useLive2dStore((s) => s.avatars[s.modelId])
  const setAvatar = useLive2dStore((s) => s.setAvatar)
  const aiConfig = useSettingsStore((s) => s.aiConfig)
  const keyStatus = useSettingsStore((s) => s.keyStatus)

  const tabs: Array<{ key: ConfigPanelTab; label: string }> = [
    { key: 'avatar', label: t('live2d.config.avatar') },
    { key: 'expressions', label: t('live2d.config.expressions') },
    { key: 'ai', label: t('live2d.config.ai') }
  ]

  return (
    <Sheet open={open} onOpenChange={(v) => setConfigPanelOpen(v)}>
      <SheetContent side="left" className="w-[320px] overflow-y-auto bg-sidebar sm:max-w-[320px]">
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
                <Label>{t('live2d.config.model')}</Label>
                <Select value={modelId} onValueChange={(value) => setModelId(resolveModelId(value))}>
                  <SelectTrigger aria-label={t('live2d.config.model')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_IDS.map((id) => (
                      <SelectItem key={id} value={id}>
                        {MODEL_PROFILES[id].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {modelId !== 'kurisu' ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('live2d.config.modelDebugHint')}
                  </p>
                ) : null}
              </div>
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
          ) : tab === 'expressions' ? (
            <ExpressionPreview />
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

/** 表情预览：情绪与动作按钮，走与 SSE 事件相同的 store 路径 */
function ExpressionPreview(): React.JSX.Element {
  const { t } = useTranslation()
  const emotion = useLive2dStore((s) => s.emotion)
  const setEmotion = useLive2dStore((s) => s.setEmotion)
  const playGesture = useLive2dStore((s) => s.playGesture)

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('live2d.config.previewHint')}</p>
      <div className="space-y-2">
        <Label>{t('live2d.config.emotions')}</Label>
        <div className="grid grid-cols-3 gap-1.5">
          {EMOTIONS.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={emotion === name}
              onClick={() => setEmotion(name)}
              className={cn(
                'rounded-md border px-2 py-1.5 text-xs transition-colors',
                emotion === name
                  ? 'border-primary/60 bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {t(`live2d.emotion.${name}`)}
            </button>
          ))}
        </div>
      </div>
      <Separator />
      <div className="space-y-2">
        <Label>{t('live2d.config.gestures')}</Label>
        <div className="grid grid-cols-3 gap-1.5">
          {GESTURES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => playGesture(name)}
              className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-primary/15 active:text-primary"
            >
              {t(`live2d.gesture.${name}`)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
