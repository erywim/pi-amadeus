import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ParticleBackground } from '@renderer/components/effects/ParticleBackground'
import { Scanlines } from '@renderer/components/effects/Scanlines'
import { ChatHistoryDialog } from './ChatHistoryDialog'
import { ConfigPanel } from './ConfigPanel'
import { DebugInput } from './DebugInput'
import { DialogBox } from './DialogBox'
import { Live2DStage } from './Live2DStage'
import { LoginOverlay } from './LoginOverlay'
import { Toolbar } from './Toolbar'
import { VideoChatWindow } from './VideoChatWindow'

/** Live2D 场景页：全屏黑 + 粒子背景 + 真实模型渲染 + 覆盖层（登录/对话框/工具栏/配置/调试） */
export default function Live2DPage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="relative h-screen overflow-hidden bg-black">
      <ParticleBackground className="opacity-70" />
      <Live2DStage className="z-10" />
      <Scanlines />
      <div className="pointer-events-none absolute left-4 top-4 z-30 font-mono text-[10px] uppercase tracking-[0.3em] text-primary/50">
        Amadeus System v0.1
      </div>
      <div className="pointer-events-none absolute right-4 top-4 z-30 font-mono text-[10px] uppercase tracking-[0.3em] text-primary/50">
        {t('app.tagline')}
      </div>
      <DialogBox />
      <Toolbar />
      <DebugInput />
      <ConfigPanel />
      <ChatHistoryDialog />
      <LoginOverlay />
      <VideoChatWindow />
    </div>
  )
}
