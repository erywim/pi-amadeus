import * as React from 'react'
import { History, LogOut, PictureInPicture2, Settings2, Video, Volume2, VolumeX } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { startCamera, stopCamera } from '@renderer/lib/camera'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { useCompanionStatus, type CompanionStatus } from './useCompanionStatus'

const STATUS_TEXT: Record<CompanionStatus, string> = {
  idle: 'companion.status.idle',
  listening: 'companion.status.listening',
  thinking: 'companion.status.thinking',
  speaking: 'companion.status.speaking'
}

/**
 * 舞台底部 HUD：角色铭牌（AMADEUS // KURISU MAKISE + 状态胶囊）+
 * 静音 + 舞台工具（摄像头 / 聊天记录 / 形象配置 / 退出登录）。
 */
export function StageHud(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useCompanionStatus()
  const ttsMuted = useUiStore((s) => s.ttsMuted)
  const setTtsMuted = useUiStore((s) => s.setTtsMuted)
  const setConfigPanelOpen = useUiStore((s) => s.setConfigPanelOpen)
  const setChatHistoryOpen = useUiStore((s) => s.setChatHistoryOpen)
  const openLogin = useUiStore((s) => s.openLogin)
  const cameraActive = useUiStore((s) => s.cameraActive)
  const setCameraActive = useUiStore((s) => s.setCameraActive)
  const userId = useSessionStore((s) => s.userId)

  // 点她一下：状态文案临时换成"……什么事？"（时钟戳过期自动回落）
  const tapNoticeUntil = useCompanionStore((s) => s.tapNoticeUntil)
  const [tapNow, setTapNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const remaining = tapNoticeUntil - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => setTapNow(Date.now()), remaining + 32)
    return () => clearTimeout(timer)
  }, [tapNoticeUntil])
  const poked = tapNoticeUntil > tapNow

  function toggleCamera(): void {
    if (!userId) {
      toast(t('common.notAvailable'))
      return
    }
    if (cameraActive) {
      stopCamera()
      setCameraActive(false)
    } else {
      startCamera()
        .then(() => setCameraActive(true))
        .catch(() => setCameraActive(false))
    }
  }

  return (
    <div className="flex items-center gap-3 border-t border-border bg-surface px-4 py-3">
      <div className="grid min-w-0 gap-px">
        <span className="font-mono text-[9.5px] tracking-[0.22em] text-muted-foreground">
          AMADEUS&nbsp;//&nbsp;KURISU MAKISE
        </span>
        <div className="flex items-center gap-2.5">
          <span className="text-[15px] font-semibold">{t('companion.charName')}</span>
          <span
            data-state={poked ? 'speaking' : status}
            className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground"
          >
            <span className={cn('status-pulse size-[7px] rounded-full', status === 'idle' && !poked && 'opacity-60')} data-state={status} />
            <span>{poked ? t('companion.tapReply') : t(STATUS_TEXT[status])}</span>
          </span>
        </div>
      </div>

      <span className="flex-1" />

      <HudIconButton
        title={ttsMuted ? t('companion.unmute') : t('companion.mute')}
        active={ttsMuted}
        onClick={() => setTtsMuted(!ttsMuted)}
      >
        {ttsMuted ? <VolumeX className="size-4" strokeWidth={1.6} /> : <Volume2 className="size-4" strokeWidth={1.6} />}
      </HudIconButton>
      <HudIconButton
        title={cameraActive ? t('live2d.toolbar.videoStop') : t('live2d.toolbar.video')}
        active={cameraActive}
        onClick={toggleCamera}
      >
        <Video className="size-4" strokeWidth={1.6} />
      </HudIconButton>
      <HudIconButton title={t('live2d.toolbar.history')} onClick={() => setChatHistoryOpen(true)}>
        <History className="size-4" strokeWidth={1.6} />
      </HudIconButton>
      <HudIconButton title={t('live2d.toolbar.settings')} onClick={() => setConfigPanelOpen(true)}>
        <Settings2 className="size-4" strokeWidth={1.6} />
      </HudIconButton>
      {/* 桌宠模式需要 Electron 主进程（纯浏览器调试环境没有 preload） */}
      {window.api && (
        <HudIconButton title={t('companion.petMode')} onClick={() => window.api.setMode('pet')}>
          <PictureInPicture2 className="size-4" strokeWidth={1.6} />
        </HudIconButton>
      )}
      <HudIconButton title={t('live2d.toolbar.logout')} onClick={openLogin}>
        <LogOut className="size-4" strokeWidth={1.6} />
      </HudIconButton>
    </div>
  )
}

/** HUD 右侧方格图标按钮（参考原型 .icon-btn） */
function HudIconButton({
  title,
  active = false,
  onClick,
  children
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          title={title}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            'grid size-9.5 place-items-center rounded-[10px] border border-border bg-surface text-ink-2 transition-colors hover:bg-surface-soft',
            active && 'bg-surface-soft text-primary'
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{title}</TooltipContent>
    </Tooltip>
  )
}
