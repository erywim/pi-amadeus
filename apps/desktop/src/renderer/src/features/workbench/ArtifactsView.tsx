import * as React from 'react'
import { Shapes } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useArtifactStore } from '@renderer/stores/artifactStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { ArtifactView } from '../chat/ArtifactPanel'
import { artifactsOf, EMPTY_MESSAGES } from './helpers'

/**
 * 工件列表 + 预览：从当前会话的助手消息里提取 HTML / SVG / Mermaid 代码块。
 * 预览直接复用聊天里的沙箱组件；没有工时时给出明确的空状态。
 */
export function ArtifactsView(): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) =>
    s.activeSessionId ? (s.messages[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const artifact = useArtifactStore((s) => s.artifact)
  const show = useArtifactStore((s) => s.show)

  const artifacts = React.useMemo(() => artifactsOf(messages), [messages])

  if (artifact) return <ArtifactView />

  return (
    <div data-testid="artifact-list" className="flex h-full min-h-0 flex-col">
      <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border px-4">
        <Shapes className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
        <span className="text-[12px] font-semibold">{t('workbench.artifacts.title')}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {t('workbench.artifacts.count', { count: artifacts.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {artifacts.length === 0 ? (
          <div className="grid h-full place-items-center px-4 text-center">
            <div>
              <Shapes className="mx-auto size-5 text-muted-foreground/60" strokeWidth={1.6} />
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                {t('workbench.artifacts.empty')}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
                {t('workbench.artifacts.emptyHint')}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {artifacts.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid="artifact-item"
                onClick={() =>
                  show({ lang: item.lang, code: item.code, title: item.title })
                }
                disabled={!sessionId}
                className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-soft"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded border border-border bg-surface-soft px-1.5 py-0 font-mono text-[9.5px] uppercase text-muted-foreground">
                    {item.lang}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    {item.title}
                  </span>
                </div>
                <pre className="mt-1 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {item.code.slice(0, 140)}
                </pre>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
