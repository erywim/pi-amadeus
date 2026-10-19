import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mic, Square, Volume2, VolumeX, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import {
  COMPANION_STATUS_TEXT,
  useCompanionStatus
} from '@renderer/features/live2d/companion/useCompanionStatus'
import type { Live2DEngine } from '@renderer/features/live2d/lib/live2d-engine'
import { startMic, stopAssistantVoiceTurn, stopMic } from '@renderer/lib/voice'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { useLive2dSpeechStore } from '@renderer/stores/live2dSpeechStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { splitSentences } from './sentences'

/** 回合结束后对话框继续停留的时长（也让最后一句读完） */
const LINGER_MS = 6000
/** 跟随角色移动的重定位间隔（拖动时对话跟着头部走） */
const REPOSITION_MS = 200

interface PetDialogProps {
  engine: Live2DEngine | null
  /** 点一下角色时递增：重新打开被手动收起的对话框 */
  reopenSignal: number
}

/**
 * 桌宠对话框：贴在角色头部一侧，显示用户气泡与按句流式回复，
 * 底栏是状态灯与最常用的几个操作（停止 / 静音 / 麦克风 / 收起）。
 * 无对话且空闲时自动隐藏；手动收起后直到下一轮对话（或再点一下角色）才出现。
 * 根节点带 data-pet-interactive：光标在其上时窗口接收鼠标（见 usePetPassthrough）。
 */
export function PetDialog({ engine, reopenSignal }: PetDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useCompanionStatus()
  const micActive = status === 'listening'
  const voiceActive = useLive2dSpeechStore((s) => s.voiceActive)
  const textStreaming = useSessionStore((s) => s.stream.streaming)
  const dialogText = useUiStore((s) => s.dialogText)
  const pendingUserText = useCompanionStore((s) => s.pendingUserText)
  const ttsMuted = useUiStore((s) => s.ttsMuted)
  const setTtsMuted = useUiStore((s) => s.setTtsMuted)
  const userId = useSessionStore((s) => s.userId)

  const busy = voiceActive || textStreaming || status === 'thinking' || status === 'speaking'
  // 语音回合的 dialogText 开头会有"你说：…"前缀（见 lib/voice.ts），气泡单独显示用户文本
  const replyText = dialogText.replace(/^你说：.*?\n?/, '')
  const hasContent = !!pendingUserText || !!replyText
  const sentences = splitSentences(replyText)
  const current = sentences.at(-1) ?? ''
  const collapsed = sentences.length > 1 ? sentences[sentences.length - 2] : null

  // 每轮对话一个序号：手动收起只对当前轮生效，下一轮自动重新出现
  const [turnSeq, setTurnSeq] = useState(0)
  const [closedTurn, setClosedTurn] = useState<number | null>(null)
  const prevVoiceActive = useRef(false)
  const prevPendingUser = useRef<string | null>(null)
  useEffect(() => {
    if (voiceActive && !prevVoiceActive.current) setTurnSeq((n) => n + 1)
    prevVoiceActive.current = voiceActive
  }, [voiceActive])
  useEffect(() => {
    if (pendingUserText && !prevPendingUser.current) setTurnSeq((n) => n + 1)
    prevPendingUser.current = pendingUserText
  }, [pendingUserText])

  const lastReopen = useRef(reopenSignal)
  useEffect(() => {
    if (reopenSignal === lastReopen.current) return
    lastReopen.current = reopenSignal
    setClosedTurn(null)
  }, [reopenSignal])

  const [visible, setVisible] = useState(false)
  const lastActivity = useRef(0)
  const hiddenByUser = closedTurn !== null && closedTurn === turnSeq
  useEffect(() => {
    if (hiddenByUser) {
      setVisible(false)
      return
    }
    if (hasContent) lastActivity.current = Date.now()
    if (micActive || busy || hasContent) {
      setVisible(true)
      if (micActive || busy) return
      // 对话结束后的停留：每次新文本都会重排计时器
      const timer = setTimeout(
        () => setVisible(false),
        Math.max(0, lastActivity.current + LINGER_MS - Date.now())
      )
      return () => clearTimeout(timer)
    }
    setVisible(false)
  }, [hiddenByUser, micActive, busy, hasContent, pendingUserText, replyText])

  // 贴在脸部一侧；侧向放不下时挪到头顶/脚下。按 5Hz 跟随角色移动。
  const dialogRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!visible || !engine) return
    const update = (): void => {
      const face = engine.faceRect()
      const el = dialogRef.current
      if (!face || !el) return
      const width = el.offsetWidth
      const height = el.offsetHeight
      const margin = 12
      const gap = 12
      const cx = face.x + face.width / 2
      const preferLeft = cx > window.innerWidth / 2
      let left = preferLeft ? face.x - width - gap : face.x + face.width + gap
      let top = face.y + face.height / 2 - height / 2
      const fitsSide = left >= margin && left + width <= window.innerWidth - margin
      if (!fitsSide) {
        left = Math.min(Math.max(cx - width / 2, margin), Math.max(margin, window.innerWidth - width - margin))
        top = face.y - height - gap
        if (top < margin) top = face.y + face.height + gap
      }
      left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin))
      top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - height - margin))
      const next = { left: Math.round(left), top: Math.round(top) }
      setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next))
    }
    update()
    const timer = window.setInterval(update, REPOSITION_MS)
    window.addEventListener('resize', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', update)
    }
  }, [visible, engine, replyText, pendingUserText])

  function stopAll(): void {
    stopAssistantVoiceTurn()
    useSessionStore.getState().stopStreaming()
    useCompanionStore.getState().setPendingUser(null)
  }

  function toggleMic(): void {
    const ui = useUiStore.getState()
    if (!useSessionStore.getState().userId) return
    if (ui.micActive) {
      stopMic()
      stopAssistantVoiceTurn()
      useCompanionStore.getState().setPendingUser(null)
      ui.setMicActive(false)
    } else {
      startMic()
        .then(() => useUiStore.getState().setMicActive(true))
        .catch(() => useUiStore.getState().setMicActive(false))
    }
  }

  function close(): void {
    const ui = useUiStore.getState()
    if (ui.micActive) {
      stopMic()
      ui.setMicActive(false)
    }
    stopAll()
    setClosedTurn(turnSeq)
  }

  if (!visible) return null

  return (
    <div
      ref={dialogRef}
      data-pet-interactive
      role="dialog"
      aria-label={t('companion.charName')}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="fixed z-10 w-[300px] max-w-[calc(100vw-24px)] select-text rounded-xl border border-border bg-surface p-3 shadow-[0_10px_40px_rgba(0,0,0,0.35)]"
    >
      {pendingUserText && (
        <div className="mb-2 flex justify-end">
          <div className="line-clamp-2 max-w-[85%] rounded-lg rounded-br-[3px] bg-primary px-2.5 py-1.5 text-[13px] leading-snug text-primary-foreground">
            {pendingUserText}
          </div>
        </div>
      )}

      <div className="min-h-[20px]" aria-live="polite">
        {collapsed && (
          <p className="mb-1 truncate text-[12px] text-muted-foreground">{collapsed}</p>
        )}
        {current ? (
          <p
            key={`${turnSeq}-${sentences.length}`}
            className="anim-msg whitespace-pre-wrap break-words text-[15px] leading-relaxed"
          >
            {current}
            {busy && (
              <span className="ml-0.5 inline-block h-3.5 w-[6px] animate-pulse bg-primary align-middle" />
            )}
          </p>
        ) : busy ? (
          <span className="inline-flex h-[1em] items-center gap-1 py-1">
            {[0, 1, 2].map((i) => (
              <i
                key={i}
                className="anim-blink inline-block size-[5px] rounded-full bg-muted-foreground"
                style={{ animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
        <span className="status-pulse size-[6px] rounded-full" data-state={status} />
        <span className="truncate text-[11.5px] text-muted-foreground">
          {t(COMPANION_STATUS_TEXT[status])}
        </span>
        <span className="flex-1" />
        {busy && (
          <DialogButton title={t('chat.stop')} onClick={stopAll}>
            <Square className="size-3 fill-current" />
          </DialogButton>
        )}
        <DialogButton
          title={ttsMuted ? t('companion.unmute') : t('companion.mute')}
          active={ttsMuted}
          onClick={() => setTtsMuted(!ttsMuted)}
        >
          {ttsMuted ? (
            <VolumeX className="size-3.5" strokeWidth={1.8} />
          ) : (
            <Volume2 className="size-3.5" strokeWidth={1.8} />
          )}
        </DialogButton>
        <DialogButton
          title={t('companion.micToggle')}
          active={micActive}
          disabled={!userId}
          onClick={toggleMic}
        >
          <Mic className="size-3.5" strokeWidth={1.8} />
        </DialogButton>
        <DialogButton title={t('pet.dialog.closeLabel')} onClick={close}>
          <X className="size-3.5" strokeWidth={1.8} />
        </DialogButton>
      </div>
    </div>
  )
}

function DialogButton({
  title,
  active = false,
  disabled = false,
  onClick,
  children
}: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground disabled:opacity-40',
        active && 'bg-accent-soft text-primary'
      )}
    >
      {children}
    </button>
  )
}
