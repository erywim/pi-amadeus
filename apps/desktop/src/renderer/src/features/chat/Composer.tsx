import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Image as ImageIcon,
  ListPlus,
  Music,
  Plus,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ATTACHMENT_LIMITS, type WorkspaceSearchHit } from '@pi-amadeus/shared'
import { searchWorkspaceFilesApi } from '@renderer/lib/api'
import { exportSessionMarkdown } from '@renderer/lib/exportSession'
import { cn } from '@renderer/lib/utils'
import { promptCommandsOf, usePluginStore } from '@renderer/stores/pluginStore'
import { activeProviderOf, useProviderStore } from '@renderer/stores/providerStore'
import {
  useSessionStore,
  type OutgoingAttachment,
  type QueuedTurn
} from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { ContextMeter } from './ContextMeter'

/** 稳定的空队列：selector 每次返回新数组会让 zustand 无限重渲染 */
const EMPTY_QUEUE: QueuedTurn[] = []

interface ComposerCommand {
  id: string
  name: string
  description: string
  icon: string
  builtin: boolean
  prompt?: string
  run?: () => void
}

/** 光标前的 @ 文件引用 token；没有则 null */
function mentionTokenAt(value: string, caret: number): { query: string; start: number; end: number } | null {
  const before = value.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  const query = match[2] ?? ''
  return { query, start: caret - query.length - 1, end: caret }
}

/**
 * 紧凑工作台风输入区：外框盒（focus 描边）+ 底部工具行
 * （附件 / 指令 / 模型 / 上下文估算 / 发送↔停止）+ 排队消息与文件引用。
 */
export function Composer(): React.JSX.Element {
  return (
    <div className="shrink-0 border-t border-border bg-surface px-5 pb-4 pt-3">
      <ChatComposerInner />
    </div>
  )
}

function ChatComposerInner(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const streaming = useSessionStore((s) => s.stream.streaming)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const flushQueue = useSessionStore((s) => s.flushQueue)
  const removeQueued = useSessionStore((s) => s.removeQueued)
  const clearQueued = useSessionStore((s) => s.clearQueued)
  const queued = useSessionStore(
    (s) => (s.activeSessionId ? s.queued[s.activeSessionId] : undefined) ?? EMPTY_QUEUE
  )
  const userId = useSessionStore((s) => s.userId)
  const setBranchTreeOpen = useUiStore((s) => s.setBranchTreeOpen)
  const theme = useSettingsStore((s) => s.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const installedPlugins = usePluginStore((s) => s.installed)
  const catalog = usePluginStore((s) => s.catalog)

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuQuery, setMenuQuery] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null)
  const [mentionItems, setMentionItems] = useState<WorkspaceSearchHit[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)

  const exportCurrent = useCallback(async (): Promise<void> => {
    if (!session) return
    try {
      const filename = await exportSessionMarkdown(session, {
        user: t('chat.exportUser'),
        assistant: 'Amadeus',
        attachments: t('chat.attachments'),
        untitled: t('chatShell.untitledTask')
      })
      toast.success(t('chat.exported', { name: filename }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [session, t])

  /** 内置斜杠命令：直接执行界面动作，不写进提示词 */
  const builtinCommands = useMemo<ComposerCommand[]>(() => {
    const items: ComposerCommand[] = [
      {
        id: 'builtin:new',
        name: '/new',
        description: t('chatShell.builtin.new'),
        icon: '✚',
        builtin: true,
        run: () => useSessionStore.getState().createSession()
      },
      {
        id: 'builtin:tree',
        name: '/tree',
        description: t('chatShell.builtin.tree'),
        icon: '🌿',
        builtin: true,
        run: () => setBranchTreeOpen(true)
      },
      {
        id: 'builtin:export',
        name: '/export',
        description: t('chatShell.builtin.export'),
        icon: '⤓',
        builtin: true,
        run: () => void exportCurrent()
      },
      {
        id: 'builtin:theme',
        name: '/theme',
        description: t('chatShell.builtin.theme'),
        icon: '◐',
        builtin: true,
        run: () => setTheme(theme === 'paper' ? 'cyber' : 'paper')
      },
      {
        id: 'builtin:settings',
        name: '/settings',
        description: t('chatShell.builtin.settings'),
        icon: '⚙',
        builtin: true,
        run: () => navigate('/settings')
      },
      {
        id: 'builtin:memory',
        name: '/memory',
        description: t('chatShell.builtin.memory'),
        icon: '🧠',
        builtin: true,
        run: () => navigate('/memory')
      },
      {
        id: 'builtin:knowledge',
        name: '/knowledge',
        description: t('chatShell.builtin.knowledge'),
        icon: '📚',
        builtin: true,
        run: () => navigate('/knowledge')
      },
      {
        id: 'builtin:automations',
        name: '/automations',
        description: t('chatShell.builtin.automations'),
        icon: '⏱',
        builtin: true,
        run: () => navigate('/automations')
      },
      {
        id: 'builtin:dashboard',
        name: '/dashboard',
        description: t('chatShell.builtin.dashboard'),
        icon: '📊',
        builtin: true,
        run: () => navigate('/dashboard')
      }
    ]
    return items
  }, [t, exportCurrent, navigate, setBranchTreeOpen, setTheme, theme])

  const commands = useMemo<ComposerCommand[]>(
    () => [
      ...builtinCommands,
      ...promptCommandsOf(installedPlugins, catalog).map((command) => ({
        id: command.id,
        name: command.name,
        description: command.description,
        icon: command.icon,
        builtin: false,
        prompt: command.prompt
      }))
    ],
    [builtinCommands, installedPlugins, catalog]
  )

  const filteredCommands = commands.filter((command) =>
    `${command.name} ${command.description}`.toLowerCase().includes(menuQuery.trim().toLowerCase())
  )

  // @ 文件引用：输入变化后按当前 token 搜索工作区（220ms 防抖）
  useEffect(() => {
    if (!mention) {
      setMentionItems([])
      return
    }
    let cancelled = false
    const query = mention.query.trim()
    if (!query) {
      setMentionItems([])
      return
    }
    const timer = window.setTimeout(() => {
      searchWorkspaceFilesApi(query)
        .then((hits) => {
          if (!cancelled) setMentionItems(hits.slice(0, 10))
        })
        .catch((error) => {
          if (!cancelled) console.warn('[composer] 工作区文件搜索失败：', error)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mention])

  function openMenu(query = ''): void {
    setMenuOpen(true)
    setMenuQuery(query)
    setMenuIndex(0)
    setMention(null)
  }

  function closeMenu(): void {
    setMenuOpen(false)
    setMenuQuery('')
    setMenuIndex(0)
  }

  function closeMention(): void {
    setMention(null)
    setMentionItems([])
    setMentionIndex(0)
  }

  function chooseCommand(command: ComposerCommand): void {
    closeMenu()
    if (command.builtin) {
      setText('')
      setMention(null)
      command.run?.()
      return
    }
    setText(command.prompt ?? '')
    setMention(null)
    // 等 React 把 value 写回 textarea 后再按内容重算高度
    window.setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      resize(el)
    }, 0)
  }

  function chooseMention(hit: WorkspaceSearchHit): void {
    if (!mention) return
    const next = `${text.slice(0, mention.start)}@${hit.path} ${text.slice(mention.end)}`
    setText(next)
    closeMention()
    window.setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      resize(el)
    }, 0)
  }

  function submit(): void {
    const value = text.trim()
    if (!value && attachments.length === 0) return
    if (!userId) {
      toast.error(t('settings.ai.loginRequired'))
      return
    }
    closeMenu()
    closeMention()
    // 流式期间 sendMessage 会放进队列；本回合结束后自动发出
    sendMessage(value, attachments)
    setText('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = ''
  }

  /** File → base64 附件；图片额外生成 data URL 预览 */
  function fileToAttachment(file: File): Promise<OutgoingAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        resolve({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: comma >= 0 ? result.slice(comma + 1) : '',
          previewUrl: file.type.startsWith('image/') ? result : ''
        })
      }
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
      reader.readAsDataURL(file)
    })
  }

  async function addFiles(files: File[]): Promise<void> {
    if (files.length === 0) return
    const room = ATTACHMENT_LIMITS.count - attachments.length
    if (room <= 0) {
      toast.error(t('chat.attachmentsLimit', { count: ATTACHMENT_LIMITS.count }))
      return
    }
    const accepted: OutgoingAttachment[] = []
    for (const file of files.slice(0, room)) {
      const kind = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('audio/')
          ? 'audio'
          : 'file'
      const limit =
        kind === 'image'
          ? ATTACHMENT_LIMITS.imageBytes
          : kind === 'audio'
            ? ATTACHMENT_LIMITS.audioBytes
            : ATTACHMENT_LIMITS.fileBytes
      if (file.size > limit) {
        toast.error(
          t('chat.attachmentTooLarge', {
            name: file.name,
            size: Math.round(limit / 1024 / 1024)
          })
        )
        continue
      }
      try {
        accepted.push(await fileToAttachment(file))
      } catch {
        toast.error(t('chat.attachmentReadFailed', { name: file.name }))
      }
    }
    if (files.length > room) {
      toast.error(t('chat.attachmentsLimit', { count: ATTACHMENT_LIMITS.count }))
    }
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted])
  }

  function resize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  return (
    <div className="mx-auto max-w-[780px]">
      <form
        className="relative rounded-xl border border-line-strong bg-surface transition-shadow focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return
          e.preventDefault()
          void addFiles([...e.dataTransfer.files])
        }}
      >
        {/* 快捷指令菜单：点「指令」按钮或输入 / 触发；内置动作排在最前 */}
        {menuOpen && (
          <div
            data-testid="command-menu"
            className="absolute bottom-[calc(100%+6px)] left-0 right-0 z-20 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-pop)]"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11.5px] text-muted-foreground">
              <Sparkles className="size-3" />
              {t('chatShell.commandsTitle')}
              <span className="flex-1" />
              <span className="font-mono text-[10px]">/</span>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filteredCommands.length === 0 ? (
                <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-muted-foreground">
                  {commands.length === 0 ? t('chatShell.commandsEmpty') : t('chatShell.commandsNoMatch')}
                </p>
              ) : (
                filteredCommands.map((command, index) => (
                  <button
                    key={command.id}
                    type="button"
                    data-testid="command-item"
                    data-command-id={command.id}
                    // mousedown 阻止默认：点选时输入框不失焦
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseCommand(command)}
                    onMouseEnter={() => setMenuIndex(index)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                      index === menuIndex ? 'bg-surface-soft' : 'hover:bg-surface-soft'
                    )}
                  >
                    <span className="text-[15px] leading-5">{command.icon}</span>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-[13px] font-semibold">{command.name}</b>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {command.description}
                      </span>
                    </span>
                    {command.builtin && (
                      <span className="mt-0.5 shrink-0 rounded border border-border px-1 py-px font-mono text-[9px] text-muted-foreground">
                        {t('chatShell.builtinBadge')}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* @ 文件引用菜单 */}
        {mention && (
          <div
            data-testid="file-mention-menu"
            className="absolute bottom-[calc(100%+6px)] left-0 right-0 z-20 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-pop)]"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11.5px] text-muted-foreground">
              <AtSign className="size-3" />
              {t('chatShell.mentionTitle')}
              <span className="flex-1" />
              <span className="max-w-[40%] truncate font-mono text-[10px]">@{mention.query}</span>
            </div>
            <div className="max-h-56 overflow-y-auto p-1">
              {mentionItems.length === 0 ? (
                <p className="px-3 py-5 text-center text-[12px] text-muted-foreground">
                  {mention.query ? t('chatShell.mentionEmpty') : t('chatShell.mentionHint')}
                </p>
              ) : (
                mentionItems.map((hit, index) => (
                  <button
                    key={hit.path}
                    type="button"
                    data-testid="file-mention-item"
                    data-path={hit.path}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseMention(hit)}
                    onMouseEnter={() => setMentionIndex(index)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                      index === mentionIndex ? 'bg-surface-soft' : 'hover:bg-surface-soft'
                    )}
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12px]">{hit.name}</span>
                      {hit.dir && (
                        <span className="block truncate text-[10.5px] text-muted-foreground">{hit.dir}</span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* 排队消息：流式期间发送的内容不会丢，也不会并发跑两个回合 */}
        {queued.length > 0 && (
          <div
            data-testid="queued-list"
            className="mx-3 mt-2.5 overflow-hidden rounded-lg border border-border bg-surface-soft/60"
          >
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground">
              <Clock3 className="size-3" />
              {t('chatShell.queuedCount', { count: queued.length })}
              <span className="flex-1" />
              {!streaming && (
                <button
                  type="button"
                  data-testid="queued-send"
                  onClick={() => activeSessionId && flushQueue(activeSessionId)}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  {t('chatShell.queuedSend')}
                </button>
              )}
              <button
                type="button"
                data-testid="queued-clear"
                onClick={() => activeSessionId && clearQueued(activeSessionId)}
                className="rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-surface hover:text-foreground"
              >
                {t('chatShell.queuedClear')}
              </button>
            </div>
            <div className="max-h-24 overflow-y-auto p-1">
              {queued.map((item) => (
                <div
                  key={item.id}
                  data-testid="queued-item"
                  className="group flex items-center gap-2 rounded-md px-2 py-1 text-[11.5px]"
                >
                  <span className="min-w-0 flex-1 truncate text-ink-2">
                    {item.text || item.attachments.map((attachment) => attachment.name).join('、')}
                  </span>
                  <button
                    type="button"
                    data-testid="queued-remove"
                    aria-label={t('chatShell.queuedRemove')}
                    title={t('chatShell.queuedRemove')}
                    onClick={() => activeSessionId && removeQueued(activeSessionId, item.id)}
                    className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {attachments.length > 0 && (
          <div data-testid="attachment-list" className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {attachments.map((item, index) => (
              <span
                key={`${item.name}-${index}`}
                data-testid="attachment-chip"
                className="group/chip relative flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-surface-soft py-1 pl-1.5 pr-6"
              >
                {item.previewUrl ? (
                  <img
                    src={item.previewUrl}
                    alt={item.name}
                    className="size-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span className="grid size-8 shrink-0 place-items-center rounded bg-surface text-muted-foreground">
                    {item.mimeType.startsWith('audio/') ? (
                      <Music className="size-3.5" />
                    ) : item.mimeType.startsWith('image/') ? (
                      <ImageIcon className="size-3.5" />
                    ) : (
                      <FileText className="size-3.5" />
                    )}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[12px] text-foreground">{item.name}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {(item.size / 1024).toFixed(0)} KB
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={t('chat.attachmentRemove')}
                  title={t('chat.attachmentRemove')}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                  className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={2}
          value={text}
          aria-label={t('chatShell.inputAria')}
          placeholder={t('chatShell.inputPlaceholder')}
          onChange={(e) => {
            const value = e.target.value
            setText(value)
            resize(e.target)
            // 以 / 开头（且还没换行）时打开指令菜单；@ 则打开工作区文件引用
            if (value.startsWith('/') && !value.includes('\n')) {
              openMenu(value.slice(1))
            } else {
              if (menuOpen) closeMenu()
              const nextMention = mentionTokenAt(value, e.target.selectionStart ?? value.length)
              setMention(nextMention)
              setMentionIndex(0)
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length === 0) return
            e.preventDefault()
            void addFiles(files)
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMenuIndex((index) => (filteredCommands.length ? (index + 1) % filteredCommands.length : 0))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMenuIndex((index) =>
                  filteredCommands.length
                    ? (index - 1 + filteredCommands.length) % filteredCommands.length
                    : 0
                )
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                closeMenu()
                return
              }
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                filteredCommands.length > 0
              ) {
                e.preventDefault()
                chooseCommand(filteredCommands[Math.min(menuIndex, filteredCommands.length - 1)]!)
                return
              }
            }
            if (mention) {
              if (e.key === 'ArrowDown' && mentionItems.length > 0) {
                e.preventDefault()
                setMentionIndex((index) => (index + 1) % mentionItems.length)
                return
              }
              if (e.key === 'ArrowUp' && mentionItems.length > 0) {
                e.preventDefault()
                setMentionIndex((index) => (index - 1 + mentionItems.length) % mentionItems.length)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                closeMention()
                return
              }
              if (
                (e.key === 'Enter' || e.key === 'Tab') &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                mentionItems.length > 0
              ) {
                e.preventDefault()
                chooseMention(mentionItems[Math.min(mentionIndex, mentionItems.length - 1)]!)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          className="block max-h-[160px] w-full resize-none border-0 bg-transparent px-3 pb-1 pt-3 text-[15px] leading-6 outline-none"
        />
        <div className="flex items-center gap-2 p-2">
          <button
            type="button"
            data-testid="attach-button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[13.5px] text-ink-2 transition-colors hover:bg-surface-soft"
          >
            <Plus className="size-3.5" strokeWidth={2} />
            {t('chatShell.attach')}
          </button>
          <input
            ref={fileInputRef}
            data-testid="attach-input"
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <button
            type="button"
            data-testid="composer-commands"
            onClick={() => (menuOpen ? closeMenu() : openMenu())}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[13.5px] text-ink-2 transition-colors hover:bg-surface-soft"
          >
            <Sparkles className="size-3.5" strokeWidth={2} />
            {t('chatShell.commands')}
          </button>
          <ModelSelector />
          <span className="flex-1" />
          <ContextMeter />
          {streaming && (
            <button
              type="button"
              aria-label={t('chat.stop')}
              title={t('chat.stop')}
              onClick={stopStreaming}
              className="grid size-[34px] place-items-center rounded-lg bg-destructive text-white transition-colors hover:brightness-90"
            >
              <Square className="size-3 fill-current" />
            </button>
          )}
          <button
            type={streaming ? 'button' : 'submit'}
            data-testid={streaming ? 'queue-send-button' : 'send-button'}
            aria-label={streaming ? t('chatShell.queueSend') : t('chat.send')}
            title={streaming ? t('chatShell.queueSend') : t('chat.send')}
            disabled={!text.trim() && attachments.length === 0}
            onClick={streaming ? submit : undefined}
            className="grid size-[34px] place-items-center rounded-lg bg-foreground text-accent-ink transition-colors hover:brightness-90 disabled:bg-line-strong"
          >
            {streaming ? (
              <ListPlus className="size-[15px]" strokeWidth={2} />
            ) : (
              <ArrowUp className="size-[15px]" strokeWidth={2} />
            )}
          </button>
        </div>
      </form>
      <p className="mt-2 text-center text-[12.5px] text-muted-foreground">
        {t('chatShell.composerHint')}
      </p>
    </div>
  )
}

/** 模型选择器：读大脑配置显示当前模型；可输入自定义模型 ID 并写回服务端 */
function ModelSelector(): React.JSX.Element {
  const { t } = useTranslation()
  const userId = useSessionStore((s) => s.userId)
  const aiConfig = useSettingsStore((s) => s.aiConfig)
  const configLoaded = useSettingsStore((s) => s.configLoaded)
  const loadAiConfig = useSettingsStore((s) => s.loadAiConfig)
  const saveAiConfig = useSettingsStore((s) => s.saveAiConfig)

  const [open, setOpen] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const [saving, setSaving] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const providers = useProviderStore((s) => s.providers)
  const updateProvider = useProviderStore((s) => s.update)
  const activeProvider = activeProviderOf(providers)

  // 激活的模型服务优先：选择器显示/写回的是真正生效的那条配置
  const currentModel = activeProvider?.model ?? aiConfig.provider.model

  const openMenu = useCallback(() => {
    setOpen(true)
    if (userId && !configLoaded) {
      loadAiConfig(userId).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    }
  }, [userId, configLoaded, loadAiConfig])

  // 点击外部收起
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCustomMode(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  async function applyModel(model: string): Promise<void> {
    if (!userId) {
      toast.error(t('settings.ai.loginRequired'))
      return
    }
    const trimmed = model.trim()
    if (!trimmed || trimmed === currentModel) {
      setOpen(false)
      setCustomMode(false)
      return
    }
    setSaving(true)
    try {
      // 有激活的模型服务时改服务里的模型；否则写回内置单条配置
      if (activeProvider) {
        await updateProvider(activeProvider.id, {
          name: activeProvider.name,
          baseUrl: activeProvider.baseUrl,
          model: trimmed,
          proxy: activeProvider.proxy,
          enabled: activeProvider.enabled
        })
      } else {
        // 配置尚未加载完成时先拉取：aiConfig 此时还是占位初值，直接写回会清空用户配置
        if (!configLoaded) {
          await loadAiConfig(userId)
        }
        const latest = useSettingsStore.getState().aiConfig
        await saveAiConfig(userId, { ...latest, provider: { ...latest.provider, model: trimmed } })
      }
      toast.success(t('chatShell.modelSaved'))
      setOpen(false)
      setCustomMode(false)
      setCustomValue('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <span ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="flex max-w-52 items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[13.5px] text-ink-2 transition-colors hover:bg-surface-soft"
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {currentModel || t('topbar.modelUnset')}
        </span>
        <ChevronDown className="size-3 shrink-0" strokeWidth={2} />
      </button>
      {open && (
        <span
          role="listbox"
          className="absolute bottom-[calc(100%+6px)] left-0 z-20 grid min-w-[220px] gap-px rounded-[10px] border border-border bg-surface p-1 shadow-[var(--shadow-pop)]"
        >
          <button
            type="button"
            role="option"
            aria-selected
            onClick={() => {
              setOpen(false)
              setCustomMode(false)
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-surface-soft"
          >
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12.5px]">
              {currentModel || t('topbar.modelUnset')}
            </span>
            <Check className={cn('size-[13px] text-primary', !currentModel && 'invisible')} />
          </button>
          {customMode ? (
            <form
              className="flex items-center gap-1.5 p-1"
              onSubmit={(e) => {
                e.preventDefault()
                void applyModel(customValue)
              }}
            >
              <input
                autoFocus
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                placeholder={t('chatShell.modelCustomPlaceholder')}
                className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1.5 font-mono text-[12.5px] outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={saving || !customValue.trim()}
                className="shrink-0 rounded-md bg-foreground px-2 py-1.5 text-[12.5px] text-accent-ink disabled:bg-line-strong"
              >
                {t('common.confirm')}
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCustomMode(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
            >
              {t('chatShell.modelCustom')}
            </button>
          )}
        </span>
      )}
    </span>
  )
}
