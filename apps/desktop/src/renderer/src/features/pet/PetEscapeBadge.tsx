import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 强制穿透的兜底入口：右上角常驻的小 logo。
 * 强制穿透开着时角色整体不可点，但这里仍接管鼠标（见 usePetPassthrough 的 escape 分支）——
 * 点开可以关掉穿透，或直接回到窗口模式。
 */
export function PetEscapeBadge({ forced }: { forced: boolean }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  // 穿透关闭 → 兜底入口消失，菜单状态复位（下次再开穿透从收起态开始）
  useEffect(() => {
    if (!forced) setOpen(false)
  }, [forced])

  if (!forced) return null

  function turnOffPassthrough(): void {
    // 强制穿透 → 关闭：角色与右键菜单恢复正常接管
    window.api.pet.setPassthrough(false)
    setOpen(false)
  }

  return (
    <div data-pet-interactive data-pet-escape className="fixed right-3 top-3 z-20 select-none">
      <button
        type="button"
        title={t('pet.escape.title')}
        aria-label={t('pet.escape.title')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid size-8 place-items-center rounded-lg border border-border/70 bg-surface/90 text-primary shadow-[0_4px_16px_rgba(0,0,0,0.35)] backdrop-blur transition-colors hover:bg-surface-soft"
      >
        <AmadeusMark className="size-4" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-[0_10px_40px_rgba(0,0,0,0.4)]">
          <button
            type="button"
            onClick={turnOffPassthrough}
            className="block w-full rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-surface-soft"
          >
            {t('pet.escape.off')}
          </button>
          <button
            type="button"
            onClick={() => window.api.setMode('window')}
            className="block w-full rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-surface-soft"
          >
            {t('pet.dialog.backToWindow')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 与托盘图标同一造型的小 logo（屏幕外框 + A） */
function AmadeusMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="19" height="17" rx="3.5" />
      <path d="M8.2 16.2 12 7.8l3.8 8.4M9.4 13.8h5.2" />
    </svg>
  )
}
