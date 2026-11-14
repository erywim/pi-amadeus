import * as React from 'react'
import { Keyboard } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { useUiStore } from '@renderer/stores/uiStore'

/** 快捷键定义：keys 只是展示文本，实际绑定分散在各处（见文件注释） */
const GROUPS: Array<{ titleKey: string; items: Array<{ keys: string[]; labelKey: string }> }> = [
  {
    titleKey: 'shortcuts.groupGeneral',
    items: [
      { keys: ['⌘/Ctrl', 'K'], labelKey: 'shortcuts.commandPalette' },
      { keys: ['⌘/Ctrl', 'N'], labelKey: 'shortcuts.newSession' },
      { keys: ['⌘/Ctrl', '/'], labelKey: 'shortcuts.thisDialog' },
      { keys: ['Esc'], labelKey: 'shortcuts.escape' }
    ]
  },
  {
    titleKey: 'shortcuts.groupComposer',
    items: [
      { keys: ['Enter'], labelKey: 'shortcuts.send' },
      { keys: ['Shift', 'Enter'], labelKey: 'shortcuts.newline' },
      { keys: ['@'], labelKey: 'shortcuts.mention' },
      { keys: ['/'], labelKey: 'shortcuts.commands' },
      { keys: ['⌘/Ctrl', 'Enter'], labelKey: 'shortcuts.saveEdit' }
    ]
  },
  {
    titleKey: 'shortcuts.groupChat',
    items: [
      { keys: ['↑', '↓'], labelKey: 'shortcuts.menuNavigate' },
      { keys: ['⌘/Ctrl', 'K'], labelKey: 'shortcuts.search' },
      { keys: ['dblclick'], labelKey: 'shortcuts.renameTitle' }
    ]
  }
]

/**
 * 快捷键速查：一处列出所有已实现的键位。
 * 绑定本身分别在 AppShell（⌘K / ⌘/）、ChatPage（⌘N / Esc）、Composer（Enter / @ / /）、
 * ChatTitlebar（双击标题改名）里，这里只做说明，不重复注册。
 */
export function ShortcutsDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.shortcutsOpen)
  const setOpen = useUiStore((s) => s.setShortcutsOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        data-testid="shortcuts-dialog"
        className="w-[min(92vw,560px)] max-w-none gap-0 overflow-hidden rounded-2xl p-0"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-primary">
            <Keyboard className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[15px]">{t('shortcuts.title')}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[12px]">
              {t('shortcuts.subtitle')}
            </DialogDescription>
          </div>
        </header>

        <div className="max-h-[62vh] overflow-y-auto px-5 py-3">
          {GROUPS.map((group) => (
            <section key={group.titleKey} className="mb-4 last:mb-1">
              <h3 className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
                {t(group.titleKey)}
              </h3>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <div
                    key={item.labelKey}
                    className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-soft"
                  >
                    <span className="flex min-w-[104px] shrink-0 items-center gap-1">
                      {item.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-border bg-surface-soft px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-[12.5px] text-ink-2">{t(item.labelKey)}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">
          {t('shortcuts.footer')}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
