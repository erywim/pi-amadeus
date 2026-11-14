import * as React from 'react'
import { useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * 模型思考过程：真实返回的 reasoning 内容，折叠展示。
 * - 默认收起（正文是主角），标题栏显示字数
 * - 流式期间保持展开：用户能实时看到思考在推进
 * - 没有思考内容时整个组件不渲染（不伪造空壳）
 */
export function ThinkingBlock({
  content,
  streaming = false
}: {
  content: string
  streaming?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const expanded = streaming || open
  if (!content.trim()) return null
  return (
    <div
      data-testid="thinking-block"
      className="rounded-lg border border-dashed border-border bg-surface-soft/60"
    >
      <button
        type="button"
        data-testid="thinking-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="size-3.5 shrink-0" strokeWidth={1.8} />
        <span className="font-medium">
          {streaming ? t('chat.thinkingRunning') : t('chat.thinking')}
        </span>
        <span className="font-mono text-[10px] opacity-70">{content.length}</span>
        <ChevronDown
          className={`ml-auto size-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
      </button>
      {expanded && (
        <div
          data-testid="thinking-content"
          className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words border-t border-border/60 px-2.5 py-2 text-[12.5px] leading-relaxed text-muted-foreground"
        >
          {content}
        </div>
      )}
    </div>
  )
}
