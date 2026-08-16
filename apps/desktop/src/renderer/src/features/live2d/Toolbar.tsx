import * as React from 'react'
import { History, LogOut, MessageSquareText, Mic, Settings, Video } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { startCamera, stopCamera } from '@renderer/lib/camera'
import { startMic, stopMic, stopAssistantVoiceTurn } from '@renderer/lib/voice'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/** 右侧竖排工具栏：mic 实时语音（VAD+STT）、video 摄像头视觉帧采集，其余与 M1 相同 */
export function Toolbar(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setConfigPanelOpen = useUiStore((s) => s.setConfigPanelOpen)
  const setChatHistoryOpen = useUiStore((s) => s.setChatHistoryOpen)
  const openLogin = useUiStore((s) => s.openLogin)
  const micActive = useUiStore((s) => s.micActive)
  const setMicActive = useUiStore((s) => s.setMicActive)
  const cameraActive = useUiStore((s) => s.cameraActive)
  const setCameraActive = useUiStore((s) => s.setCameraActive)
  const userId = useSessionStore((s) => s.userId)

  function toggleMic(): void {
    if (!userId) {
      toast(t('common.notAvailable'))
      return
    }
    if (micActive) {
      stopMic()
      // 关麦同时中止进行中的语音回合与 TTS 播放
      stopAssistantVoiceTurn()
      setMicActive(false)
    } else {
      startMic()
        .then(() => setMicActive(true))
        .catch(() => setMicActive(false))
    }
  }

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
    <div className="absolute right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1.5 rounded-lg border border-border bg-card/70 p-1.5 backdrop-blur-sm">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleMic}
            className={cn(
              'size-9 hover:bg-primary/10 hover:text-primary',
              micActive ? 'bg-primary/15 text-primary shadow-[0_0_12px_rgba(0,229,255,0.4)]' : 'text-muted-foreground'
            )}
          >
            <Mic strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {micActive ? t('live2d.toolbar.micStop') : t('live2d.toolbar.mic')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleCamera}
            className={cn(
              'size-9 hover:bg-primary/10 hover:text-primary',
              cameraActive ? 'bg-primary/15 text-primary shadow-[0_0_12px_rgba(0,229,255,0.4)]' : 'text-muted-foreground'
            )}
          >
            <Video strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {cameraActive ? t('live2d.toolbar.videoStop') : t('live2d.toolbar.video')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setChatHistoryOpen(true)}
            className="size-9 text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <History strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{t('live2d.toolbar.history')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfigPanelOpen(true)}
            className="size-9 text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <Settings strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{t('live2d.toolbar.settings')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/chat')}
            className="size-9 text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <MessageSquareText strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{t('live2d.toolbar.chat')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openLogin()}
            className="size-9 text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <LogOut strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{t('live2d.toolbar.logout')}</TooltipContent>
      </Tooltip>
    </div>
  )
}
