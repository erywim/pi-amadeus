import * as React from 'react'
import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'
import { usePluginStore } from '@renderer/stores/pluginStore'

/**
 * 自定义 MCP 服务：目录之外的高级入口。
 * 命令在本机以子进程运行——界面上必须让用户看清这一点。
 */
export function AddMcpDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const addCustomMcp = usePluginStore((s) => s.addCustomMcp)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('npx')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(): Promise<void> {
    if (!name.trim() || !command.trim()) return
    setSaving(true)
    try {
      await addCustomMcp({
        name: name.trim(),
        command: command.trim(),
        args: args
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        env: Object.fromEntries(
          env
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const index = line.indexOf('=')
              return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1)] : null
            })
            .filter((entry): entry is [string, string] => entry !== null)
        )
      })
      toast.success(t('plugins.mcp.added'))
      setName('')
      setArgs('')
      setEnv('')
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-lg rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-[17px]">{t('plugins.mcp.addTitle')}</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {t('plugins.mcp.addDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-name" className="text-[12.5px]">
              {t('plugins.mcp.name')}
            </Label>
            <Input
              id="mcp-name"
              value={name}
              placeholder="My MCP Server"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-command" className="text-[12.5px]">
              {t('plugins.mcp.command')}
            </Label>
            <Input
              id="mcp-command"
              value={command}
              placeholder="npx"
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-args" className="text-[12.5px]">
              {t('plugins.mcp.args')}
            </Label>
            <Textarea
              id="mcp-args"
              rows={3}
              value={args}
              placeholder={'-y\n@modelcontextprotocol/server-memory'}
              onChange={(e) => setArgs(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-env" className="text-[12.5px]">
              {t('plugins.mcp.env')}
            </Label>
            <Textarea
              id="mcp-env"
              rows={2}
              value={env}
              placeholder={'API_KEY=...'}
              onChange={(e) => setEnv(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving || !name.trim() || !command.trim()} onClick={() => void submit()}>
            {saving && <LoaderCircle className="size-3.5 animate-spin" />}
            {t('plugins.mcp.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
