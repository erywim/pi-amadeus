import * as React from 'react'
import { useEffect } from 'react'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { ChatHistoryDialog } from './ChatHistoryDialog'
import { ConfigPanel } from './ConfigPanel'
import { LoginOverlay } from './LoginOverlay'
import { CompanionComposer } from './companion/CompanionComposer'
import { CompanionThread } from './companion/CompanionThread'
import { StageBay } from './companion/StageBay'
import { StageHud } from './companion/StageHud'

/**
 * 陪伴模式页（OpenDesign 原型布局）：左舞台（Live2D + HUD），右对话流
 * （气泡 + 快速话题 + 麦克风/输入框）。挂载时 body 翻转 theme-amadeus
 * （由 AppShell 驱动），进入暗色实验台。
 * 语音与文本回合共享同一会话列表：选中会话若无则展示首轮引导，首条
 * 消息发出时由语音链路自动创建。
 */
export default function CompanionPage(): React.JSX.Element {
  const userId = useSessionStore((s) => s.userId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)

  // 进入陪伴页：有历史会话则默认接最新消息，无则等首条消息创建
  useEffect(() => {
    if (userId && !activeSessionId && sessions.length > 0) {
      selectSession(sessions[0]!.id)
    }
    // sessions 初次拉取后再补一次选中（userId/sessions 异步到达）
  }, [userId, activeSessionId, sessions, selectSession])

  return (
    <div className="relative grid h-full min-h-0 grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
      {/* 左：实验台舞台 */}
      <section className="grid min-w-0 grid-rows-[minmax(0,1fr)_auto]">
        <StageBay />
        <StageHud />
      </section>

      {/* 右：对话流 */}
      <aside className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] border-l border-border bg-surface">
        <CompanionThread />
        <CompanionComposer />
      </aside>

      {/* 覆盖层 */}
      <ConfigPanel />
      <ChatHistoryDialog />
      <LoginOverlay />
    </div>
  )
}
