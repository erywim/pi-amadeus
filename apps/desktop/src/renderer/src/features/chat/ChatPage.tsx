import * as React from 'react'
import { useState } from 'react'
import { useSessionStore } from '@renderer/stores/sessionStore'
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
  const [sidebarOpen, setSidebarOpen] = useState(true)

  return (
    <div className="flex h-full min-h-0 flex-1 bg-surface">
      {sidebarOpen && <SessionSidebar />}
      <section className="flex min-w-0 flex-1 flex-col">
        {activeSessionId === null ? (
          <WelcomeState />
        ) : (
          <>
            <CodexTitlebar
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
            />
            <MessageList />
            <Composer />
          </>
        )}
      </section>
    </div>
  )
}
