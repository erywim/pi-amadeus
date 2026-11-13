import * as React from 'react'
import { useEffect, useState } from 'react'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { ProviderStrip } from '../workbench/ProviderStrip'
import { StagePipeline } from '../workbench/StagePipeline'
import { WorkbenchSidePanel } from '../workbench/WorkbenchSidePanel'
import { WorkbenchStatusBar } from '../workbench/WorkbenchStatusBar'
import { CodexTitlebar } from './CodexTitlebar'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { SessionSidebar } from './SessionSidebar'
import { WelcomeState } from './WelcomeState'

/**
 * 文本模式页（Codex 风）：可收纳会话侧栏 + 标题栏 + 智能体对话列
 * （工作过程折叠卡 + markdown 正文）+ 盒式输入区。
 */
export default function ChatPage(): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const createSession = useSessionStore((s) => s.createSession)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sideOpen, setSideOpen] = useState(true)

  // 常见助手的快捷键：⌘/Ctrl+N 新会话、Esc 停止正在生成的回合
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createSession()
        return
      }
      if (e.key === 'Escape') {
        // 只有真的在流式时才拦截 Esc，其余情况交给输入框/弹层自己处理
        if (!useSessionStore.getState().stream.streaming) return
        e.preventDefault()
        stopStreaming()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
              <CodexTitlebar
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
