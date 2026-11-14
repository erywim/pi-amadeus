import * as React from 'react'
import { Bell, MonitorCog, Moon, Sparkles, Sun, VolumeX, Waypoints } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore, type DefaultMode, type UiTheme } from '@renderer/stores/settingsStore'

/** 通用设置：外观主题 / 启动默认模式 / 陪伴模式默认静音（全部本地持久化） */
export function GeneralPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const theme = useSettingsStore((s) => s.theme)
  const defaultMode = useSettingsStore((s) => s.defaultMode)
  const defaultMute = useSettingsStore((s) => s.defaultMute)
  const proactiveEnabled = useSettingsStore((s) => s.proactiveEnabled ?? true)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const setDefaultMode = useSettingsStore((s) => s.setDefaultMode)
  const setDefaultMute = useSettingsStore((s) => s.setDefaultMute)
  const setProactiveEnabled = useSettingsStore((s) => s.setProactiveEnabled)

  // macOS 截屏需要屏幕录制权限：没授权时说明"开了也不会看屏幕"，别让开关看起来坏了
  const [screenPermission, setScreenPermission] = React.useState('granted')
  React.useEffect(() => {
    if (!proactiveEnabled || !window.api?.proactive) return
    let cancelled = false
    window.api.proactive
      .permission()
      .then((status) => {
        if (!cancelled) setScreenPermission(status)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [proactiveEnabled])

  const notifyOnComplete = useSettingsStore((s) => s.notifyOnComplete)
  const setNotifyOnComplete = useSettingsStore((s) => s.setNotifyOnComplete)
  const notifyDenied =
    notifyOnComplete &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'denied'

  return (
    <div className="max-w-xl">
      <h2 className="text-base font-semibold">{t('settings.general.title')}</h2>
      <p className="mb-6 mt-1 text-xs text-muted-foreground">{t('settings.general.desc')}</p>
      <div className="space-y-6">
        <div className="space-y-2">
          <Label>
            <MonitorCog className="mr-1 inline size-3.5 align-[-2px]" />
            {t('settings.general.theme')}
          </Label>
          <div className="flex gap-2">
            <SegmentButton
              active={theme === 'paper'}
              icon={<Sun className="size-3.5" />}
              label={t('settings.general.themePaper')}
              onClick={() => setTheme('paper' as UiTheme)}
            />
            <SegmentButton
              active={theme === 'cyber'}
              icon={<Moon className="size-3.5" />}
              label={t('settings.general.themeCyber')}
              onClick={() => setTheme('cyber' as UiTheme)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.general.themeHint')}</p>
        </div>

        <div className="space-y-2">
          <Label>
            <Waypoints className="mr-1 inline size-3.5 align-[-2px]" />
            {t('settings.general.defaultMode')}
          </Label>
          <div className="flex gap-2">
            <SegmentButton
              active={defaultMode === 'companion'}
              label={t('nav.companion')}
              onClick={() => setDefaultMode('companion' as DefaultMode)}
            />
            <SegmentButton
              active={defaultMode === 'text'}
              label={t('nav.text')}
              onClick={() => setDefaultMode('text' as DefaultMode)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>
              <VolumeX className="mr-1 inline size-3.5 align-[-2px]" />
              {t('settings.general.defaultMute')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('settings.general.defaultMuteDesc')}</p>
          </div>
          <Switch checked={defaultMute} onCheckedChange={setDefaultMute} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>
              <Sparkles className="mr-1 inline size-3.5 align-[-2px]" />
              {t('settings.general.proactive')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('settings.general.proactiveDesc')}</p>
            {proactiveEnabled && screenPermission !== 'granted' && (
              <p className="text-xs text-destructive">{t('settings.general.proactivePermission')}</p>
            )}
          </div>
          <Switch
            checked={proactiveEnabled}
            onCheckedChange={(enabled) => {
              setProactiveEnabled(enabled)
              // 打开开关是用户主动操作：此时才去触发系统截屏授权（否则系统不会把应用列进屏幕录制列表）
              if (enabled) {
                window.api?.proactive
                  .requestPermission()
                  .then(setScreenPermission)
                  .catch(() => {})
              }
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>
              <Bell className="mr-1 inline size-3.5 align-[-2px]" />
              {t('settings.general.notifyOnComplete')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {notifyDenied
                ? t('settings.general.notifyDenied')
                : t('settings.general.notifyOnCompleteDesc')}
            </p>
          </div>
          <Switch checked={notifyOnComplete} onCheckedChange={setNotifyOnComplete} />
        </div>
      </div>
    </div>
  )
}

/** 分段选择按钮（kv 组用） */
function SegmentButton({
  active,
  label,
  icon,
  onClick
}: {
  active: boolean
  label: string
  icon?: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-[10px] border px-3.5 py-2 text-sm transition-colors',
        active
          ? 'border-primary/50 bg-accent-soft font-medium text-primary'
          : 'border-border bg-surface text-ink-2 hover:bg-surface-soft'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
