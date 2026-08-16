import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

/**
 * 聊天 markdown 渲染管线：GFM + sanitize（LLM 输出不可信，必须消毒），
 * 不依赖 typography 插件——样式全部手写映射。
 */
const components: Components = {
  p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="opacity-70 line-through">{children}</del>,
  h1: ({ children }) => <h1 className="mb-2 mt-3 text-lg font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-sm font-bold">{children}</h3>,
  hr: () => <hr className="my-3 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-primary/50 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-4 hover:text-cyber-cyan-dim"
      onClick={(e) => {
        // 桌面应用：window.open → 主进程 setWindowOpenHandler → shell.openExternal
        e.preventDefault()
        if (href) window.open(href, '_blank')
      }}
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/40 px-3 py-1.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-3 py-1.5">{children}</td>,
  // 行内代码 vs 代码块：sanitize 默认 schema 允许 code 上的 language-* class，
  // 无语言标注的围栏代码靠换行符识别
  code: ({ className, children }) => {
    const isBlock = (className ?? '').startsWith('language-') || String(children).includes('\n')
    if (!isBlock) {
      return (
        <code className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[0.85em] text-cyber-cyan">
          {children}
        </code>
      )
    }
    const lang = (className ?? '').replace('language-', '') || 'code'
    return (
      <div className="my-3 overflow-hidden rounded-md border border-border bg-black/40">
        <div className="border-b border-border bg-muted/40 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {lang}
        </div>
        <pre className="overflow-x-auto p-3">
          <code className="font-mono text-[13px] leading-relaxed text-terminal-green">{children}</code>
        </pre>
      </div>
    )
  },
  // pre 透传：块级代码的结构由上面的 code 组件接管
  pre: ({ children }) => <>{children}</>,
  img: (props) => <img className="my-2 max-w-full rounded-md" {...props} alt={props.alt ?? ''} />
}

interface MarkdownProps {
  content: string
}

export function Markdown({ content }: MarkdownProps): React.JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
      {content}
    </ReactMarkdown>
  )
}
