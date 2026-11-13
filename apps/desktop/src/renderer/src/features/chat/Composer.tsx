import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronDown, Plus, Sparkles, Square } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { promptCommandsOf, usePluginStore, type PromptCommand } from '@renderer/stores/pluginStore'
import { activeProviderOf, useProviderStore } from '@renderer/stores/providerStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'

/**
 * 紧凑工作台风输入区：外框盒（focus 描边）+ 底部工具行
 * （附件占位 / 模型选择器（写回大脑配置）/ 发送↔停止一体按钮）+ 快捷键提示。
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
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streaming = useSessionStore((s) => s.stream.streaming)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const userId = useSessionStore((s) => s.userId)
  const installedPlugins = usePluginStore((s) => s.installed)
  const catalog = usePluginStore((s) => s.catalog)
  const commands = React.useMemo(
    () => promptCommandsOf(installedPlugins, catalog),
    [installedPlugins, catalog]
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuQuery, setMenuQuery] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  const filteredCommands = commands.filter((command) =>
    `${command.name} ${command.description}`.toLowerCase().includes(menuQuery.trim().toLowerCase())
  )

  function openMenu(query = ''): void {
    setMenuOpen(true)
    setMenuQuery(query)
    setMenuIndex(0)
  }

  function closeMenu(): void {
    setMenuOpen(false)
    setMenuQuery('')
    setMenuIndex(0)
  }

  function chooseCommand(command: PromptCommand): void {
    setText(command.prompt)
    closeMenu()
    // 等 React 把 value 写回 textarea 后再按内容重算高度
    window.setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      resize(el)
    }, 0)
  }

  function submit(): void {
    const value = text.trim()
    if (!value || streaming) return
    // 未登录（或大脑服务不可达导致建档失败）时提示去陪伴模式完成身份认证
    if (!userId) {
      toast.error(t('settings.ai.loginRequired'))
      return
    }
    closeMenu()
    sendMessage(value)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = ''
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
      >
        {/* 快捷指令菜单：点「指令」按钮或输入 / 触发 */}
        {menuOpen && (
          <div className="absolute bottom-[calc(100%+6px)] left-0 right-0 z-20 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-pop)]">
            <div className="border-b border-border px-3 py-2 text-[11.5px] text-muted-foreground">
              {t('chatShell.commandsTitle')}
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
                    <span className="min-w-0">
                      <b className="block truncate text-[13px] font-semibold">{command.name}</b>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {command.description}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
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
            // 以 / 开头（且还没换行）时打开指令菜单，后续输入作为过滤词
            if (value.startsWith('/') && !value.includes('\n')) openMenu(value.slice(1))
            else if (menuOpen) closeMenu()
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
            onClick={() => toast(t('chatShell.attachWip'))}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[13.5px] text-ink-2 transition-colors hover:bg-surface-soft"
          >
            <Plus className="size-3.5" strokeWidth={2} />
            {t('chatShell.attach')}
          </button>
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
          {streaming ? (
            <button
              type="button"
              aria-label={t('chat.stop')}
              title={t('chat.stop')}
              onClick={stopStreaming}
              className="grid size-[34px] place-items-center rounded-lg bg-destructive text-white transition-colors hover:brightness-90"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label={t('chat.send')}
              title={t('chat.send')}
              disabled={!text.trim()}
              className="grid size-[34px] place-items-center rounded-lg bg-foreground text-accent-ink transition-colors hover:brightness-90 disabled:bg-line-strong"
            >
              <ArrowUp className="size-[15px]" strokeWidth={2} />
            </button>
          )}
        </div>
      </form>
      <p className="mt-2 text-center text-[12.5px] text-muted-foreground">{t('chatShell.composerHint')}</p>
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
