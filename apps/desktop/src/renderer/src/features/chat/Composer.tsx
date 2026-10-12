import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronDown, Plus, Square } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'

/**
 * Codex 风输入区：外框盒（focus 描边）+ 底部工具行
 * （附件占位 / 模型选择器（写回大脑配置）/ 发送↔停止一体按钮）+ 快捷键提示。
 */
export function Composer(): React.JSX.Element {
  return (
    <div className="shrink-0 border-t border-border bg-surface px-5 pb-4 pt-3">
      <CodexComposerInner />
    </div>
  )
}

function CodexComposerInner(): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streaming = useSessionStore((s) => s.stream.streaming)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const userId = useSessionStore((s) => s.userId)

  function submit(): void {
    const value = text.trim()
    if (!value || streaming) return
    // 未登录（或大脑服务不可达导致建档失败）时提示去陪伴模式完成身份认证
    if (!userId) {
      toast.error(t('settings.ai.loginRequired'))
      return
    }
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
        className="rounded-xl border border-line-strong bg-surface transition-shadow focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={textareaRef}
          rows={2}
          value={text}
          aria-label={t('codex.inputAria')}
          placeholder={t('codex.inputPlaceholder')}
          onChange={(e) => {
            setText(e.target.value)
            resize(e.target)
          }}
          onKeyDown={(e) => {
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
            onClick={() => toast(t('codex.attachWip'))}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[13.5px] text-ink-2 transition-colors hover:bg-surface-soft"
          >
            <Plus className="size-3.5" strokeWidth={2} />
            {t('codex.attach')}
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
      <p className="mt-2 text-center text-[12.5px] text-muted-foreground">{t('codex.composerHint')}</p>
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

  const currentModel = aiConfig.provider.model

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
      await saveAiConfig(userId, { ...aiConfig, provider: { ...aiConfig.provider, model: trimmed } })
      toast.success(t('codex.modelSaved'))
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
                placeholder={t('codex.modelCustomPlaceholder')}
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
              {t('codex.modelCustom')}
            </button>
          )}
        </span>
      )}
    </span>
  )
}
