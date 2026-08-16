import * as React from 'react'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { SessionSidebar } from './SessionSidebar'
import { WelcomeState } from './WelcomeState'

/** 文本聊天页：会话侧栏 + 消息列；无选中会话时显示欢迎屏 */
export default function ChatPage(): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  return (
    <div className="flex h-full min-h-0 flex-1">
      <SessionSidebar />
      <section className="flex min-w-0 flex-1 flex-col">
        {activeSessionId === null ? (
          <WelcomeState />
        ) : (
          <>
            <ChatHeader />
            <MessageList />
            <Composer />
          </>
        )}
      </section>
    </div>
  )
}
