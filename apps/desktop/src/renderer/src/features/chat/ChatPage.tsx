import * as React from 'react'
import { useEffect, useState } from 'react'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { ProviderStrip } from '../workbench/ProviderStrip'
import { StagePipeline } from '../workbench/StagePipeline'
import { WorkbenchSidePanel } from '../workbench/WorkbenchSidePanel'
import { WorkbenchStatusBar } from '../workbench/WorkbenchStatusBar'
import { ChatTitlebar } from './ChatTitlebar'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { SessionSidebar } from './SessionSidebar'
import { WelcomeState } from './WelcomeState'

/**
 * 文本模式页（紧凑工作台风）：可收纳会话侧栏 + 标题栏 + 智能体对话列
 * （工作过程折叠卡 + markdown 正文）+ 盒式输入区。
 */
export default function ChatPage(): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const createSession = useSessionStore((s) => s.createSession)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sideOpen, setSideOpen] = useState(true)
  const diffRequest = useUiStore((s) => s.workspaceDiffRequest)

  // 消息里的改动卡请求看 diff：右侧面板可能是收起的（甚至还没挂载），
  // 必须先展开，否则点了文件名什么都不会发生
  useEffect(() => {
    if (diffRequest) setSideOpen(true)
  }, [diffRequest])

  // 常见助手的快捷键：⌘/Ctrl+N 新会话、Esc 停止正在生成的回合
  useEffect(() => {
    /** 按下 Esc 那一刻是否有全局弹层开着（捕获阶段取值，冒泡阶段再决定） */
    let overlayWasOpen = false

    function onCapture(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      const ui = useUiStore.getState()
      overlayWasOpen = ui.commandPaletteOpen || ui.branchTreeOpen || ui.shortcutsOpen
      if (!overlayWasOpen) {
        // 弹层可能是 Radix 自己的（如 Bash 确认卡的包装层）：页面上有 dialog 时同样不算「给聊天用的 Esc」
        overlayWasOpen = document.querySelector('[role="dialog"][data-state="open"]') !== null
      }
    }

    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createSession()
        return
      }
      if (e.key === 'Escape') {
        // Esc 只关最上面那一层：弹层开着、输入框的菜单已经接管（preventDefault）
        // 时，都不能顺手把正在生成的回合也停掉
        if (overlayWasOpen || e.defaultPrevented) return
        if (!useSessionStore.getState().stream.streaming) return
        e.preventDefault()
        stopStreaming()
      }
    }
    // 捕获阶段先记下弹层状态：Radix 会在 document 上同步关掉弹层，
    // 等到冒泡到 window 时已经查不到「刚才是否开着」
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [createSession, stopStreaming])

  return (
    <div
      data-testid="workbench"
      className="agent-workbench grid h-full min-h-0 grid-rows-[minmax(0,1fr)_30px] bg-background text-foreground"
    >
      <div className="flex min-h-0">
        {sidebarOpen && <SessionSidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <ProviderStrip />
          {activeSessionId === null ? (
            <WelcomeState />
          ) : (
            <>
              <ChatTitlebar
                sidebarOpen={sidebarOpen}
                onToggleSidebar={() => setSidebarOpen((v) => !v)}
                sideOpen={sideOpen}
                onToggleSide={() => setSideOpen((v) => !v)}
              />
              <div className="flex min-h-0 flex-1">
                <section className="flex min-w-0 flex-1 flex-col">
                  <StagePipeline />
                  <MessageList />
                  <Composer />
                </section>
                {sideOpen && <WorkbenchSidePanel onCollapse={() => setSideOpen(false)} />}
              </div>
            </>
          )}
        </div>
      </div>
      <WorkbenchStatusBar />
    </div>
  )
}
