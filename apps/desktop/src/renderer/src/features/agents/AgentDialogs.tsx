import * as React from 'react'
import { useRef, useState } from 'react'
import { LoaderCircle, Terminal } from 'lucide-react'
import toast from 'react-hot-toast'
import type { AgentProfile, AgentProfileInput, AgentRuntime, AgentTask } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'
import { useAgentStore } from '@renderer/stores/agentStore'
import { useAgentText } from './translations'

const runtimes: AgentRuntime[] = ['brain', 'claude', 'codex', 'opencode', 'pi', 'gemini', 'aider', 'goose', 'qwen', 'copilot', 'custom']
const selectClass = 'h-9 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const checkboxClass = 'size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const dialogClass = 'max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto overscroll-contain rounded-xl motion-reduce:animate-none motion-reduce:transition-none [&_button]:motion-reduce:transition-none'
const absolutePath = (value: string): boolean => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
const showError = (error: unknown): void => { toast.error(error instanceof Error ? error.message : String(error)) }

export function ProfileDialog({ profile, onClose }: { profile?: AgentProfile; onClose: () => void }): React.JSX.Element {
  const text = useAgentText()
  const discovered = useAgentStore((state) => state.discovered)
  const saveProfile = useAgentStore((state) => state.saveProfile)
  const [form, setForm] = useState<AgentProfileInput>(() => profile ? {
    name: profile.name, runtime: profile.runtime, command: profile.command, args: profile.args,
    promptMode: profile.promptMode, instructions: profile.instructions, model: profile.model,
    enabled: profile.enabled, allowRemote: profile.allowRemote
  } : {
    name: 'amadeus', runtime: 'brain', command: '', args: [], promptMode: 'stdin',
    instructions: '', model: '', enabled: true, allowRemote: false
  })
  const [args, setArgs] = useState(() => JSON.stringify(profile?.args ?? [], null, 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const detection = discovered.find((item) => item.runtime === form.runtime)
  const patch = <K extends keyof AgentProfileInput>(key: K, value: AgentProfileInput[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (submitting.current) return
    let parsed: string[] = form.args
    if (form.runtime === 'custom') {
      if (!absolutePath(form.command.trim())) { setError(text('pathError')); return }
      if (args.trim().startsWith('[')) {
        try {
          const value: unknown = JSON.parse(args)
          if (!Array.isArray(value) || !value.every((argument) => typeof argument === 'string')) throw new Error()
          parsed = value as string[]
        } catch { setError(text('argsError')); return }
      } else parsed = args.split(/\r?\n/).filter((line) => line.trim() !== '')
      if (form.promptMode === 'argument' && !parsed.includes('{prompt}')) { setError(text('promptArgError')); return }
    }
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await saveProfile({ ...form, name: form.name.trim(), command: form.runtime === 'custom' ? form.command.trim() : form.command, args: parsed }, profile?.id)
      toast.success(text('saved'))
      // 保存成功才关闭，失败保留用户的完整配置草稿。
      onClose()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      toast.error(message)
    } finally { submitting.current = false; setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className={dialogClass} data-testid="agent-profile-dialog">
        <DialogHeader>
          <DialogTitle>{text(profile ? 'editAgent' : 'addAgent')}</DialogTitle>
          <DialogDescription>{text('profileDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-profile-name">{text('name')}</Label>
              <Input id="agent-profile-name" data-testid="agent-profile-name" value={form.name} required maxLength={100} onChange={(event) => patch('name', event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-profile-runtime">{text('runtime')}</Label>
              <select id="agent-profile-runtime" data-testid="agent-profile-runtime" className={selectClass} value={form.runtime} onChange={(event) => {
                const runtime = event.target.value as AgentRuntime
                // 切换执行器不继承另一种适配器的启动参数或远程授权，避免意外执行。
                setForm((previous) => ({ ...previous, runtime, name: !profile && previous.name === 'amadeus' ? runtime : previous.name, command: '', args: [], promptMode: 'stdin', allowRemote: false }))
                setArgs('[]')
              }}>
                {runtimes.map((runtime) => <option key={runtime} value={runtime}>{runtime === 'brain' ? 'amadeus · brain' : runtime}</option>)}
              </select>
            </div>
          </div>
          {detection && (
            <div className="rounded-md border border-border bg-surface-soft p-3 text-xs leading-relaxed" data-testid="agent-profile-detection">
              <p className={detection.installed ? 'font-medium text-primary' : 'font-medium text-muted-foreground'}>
                <Terminal className="mr-1.5 inline size-3.5" aria-hidden="true" />
                {text(detection.installed ? 'installed' : 'notInstalled')} · {text(detection.supported ? 'supported' : 'unsupported')}
              </p>
              {detection.path && <p className="mt-1 break-all font-mono text-ink-2">{detection.path}</p>}
              {detection.version && <p className="mt-1 break-words font-mono text-muted-foreground">{text('version')}: {detection.version}</p>}
              {detection.note && <p className="mt-1 text-muted-foreground">{detection.note}</p>}
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-profile-model">{text('model')}</Label>
            <Input id="agent-profile-model" data-testid="agent-profile-model" value={form.model} onChange={(event) => patch('model', event.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-profile-instructions">{text('instructions')}</Label>
            <Textarea id="agent-profile-instructions" data-testid="agent-profile-instructions" rows={4} value={form.instructions} onChange={(event) => patch('instructions', event.target.value)} />
          </div>
          {form.runtime === 'custom' && (
            <fieldset className="grid gap-3 rounded-lg border border-border p-3">
              <legend className="px-1 font-mono text-xs text-primary">custom</legend>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-profile-command">{text('executable')}</Label>
                <Input id="agent-profile-command" data-testid="agent-profile-command" className="font-mono text-xs" value={form.command} required onChange={(event) => patch('command', event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-profile-args">{text('args')}</Label>
                <Textarea id="agent-profile-args" data-testid="agent-profile-args" className="font-mono text-xs" rows={3} value={args} onChange={(event) => setArgs(event.target.value)} aria-describedby="agent-profile-args-help" />
                <p id="agent-profile-args-help" className="text-xs leading-relaxed text-muted-foreground">{text('argsHint')}</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-profile-prompt-mode">{text('promptMode')}</Label>
                <select id="agent-profile-prompt-mode" data-testid="agent-profile-prompt-mode" className={selectClass} value={form.promptMode} onChange={(event) => patch('promptMode', event.target.value as 'stdin' | 'argument')}>
                  <option value="stdin">{text('stdin')}</option><option value="argument">{text('argument')}</option>
                </select>
              </div>
            </fieldset>
          )}
          <label className="flex items-center gap-2 text-sm"><input data-testid="agent-profile-enabled" className={checkboxClass} type="checkbox" checked={form.enabled} onChange={(event) => patch('enabled', event.target.checked)} />{text('enabled')}</label>
          <div className="rounded-lg border border-border bg-surface-soft p-3">
            <label className="flex items-start gap-2 text-sm"><input data-testid="agent-profile-allow-remote" className={`${checkboxClass} mt-0.5`} type="checkbox" checked={form.allowRemote} onChange={(event) => patch('allowRemote', event.target.checked)} aria-describedby="agent-profile-remote-help" />{text('allowRemote')}</label>
            <p id="agent-profile-remote-help" className="mt-2 text-xs leading-relaxed text-muted-foreground">{text('remoteWarning')}</p>
          </div>
          {error && <p role="alert" data-testid="agent-profile-error" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{text('cancel')}</Button>
            <Button data-testid="agent-profile-save" type="submit" disabled={busy || !form.name.trim()}>{busy && <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />}{text(busy ? 'saving' : 'save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type TaskDialogMode = { kind: 'create'; agentId?: string } | { kind: 'continue' | 'handoff'; task: AgentTask }

export function TaskDialog({ mode, userId, onClose }: { mode: TaskDialogMode; userId: string; onClose: () => void }): React.JSX.Element {
  const text = useAgentText()
  const profiles = useAgentStore((state) => state.profiles)
  const tasks = useAgentStore((state) => state.tasks)
  const createTask = useAgentStore((state) => state.createTask)
  const taskAction = useAgentStore((state) => state.taskAction)
  const candidates = profiles.filter((profile) => profile.enabled)
  const defaultAgent = mode.kind === 'create' ? mode.agentId : mode.kind === 'continue' ? mode.task.agentId : ''
  const [agentId, setAgentId] = useState(() => candidates.find((profile) => profile.id === defaultAgent)?.id ?? candidates.find((profile) => profile.id === 'amadeus')?.id ?? candidates[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [missionId, setMissionId] = useState('')
  const [parentTaskId, setParentTaskId] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submission = useRef<{ signature: string; requestId: string } | null>(null)
  const submitting = useRef(false)
  const agent = profiles.find((profile) => profile.id === agentId)
  const description = mode.kind === 'create' ? 'taskDescription' : mode.kind === 'handoff' ? 'handoffDescription' : 'continueDescription'

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (submitting.current || !agent?.enabled || (mode.kind === 'create' && (!title.trim() || !prompt.trim()))) return
    const workingDirectory = mode.kind === 'create' ? cwd.trim() : mode.task.cwd
    if (agent.runtime !== 'brain' && !absolutePath(workingDirectory)) { setError(text('cwdRequired')); return }
    const payload = mode.kind === 'create' ? {
      userId, agentId, title: title.trim(), prompt: prompt.trim(), cwd: workingDirectory,
      ...(missionId.trim() ? { missionId: missionId.trim() } : {}),
      ...(parentTaskId ? { parentTaskId } : {}), ...(dependsOn.length ? { dependsOn } : {})
    } : { userId, agentId, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) }
    const signature = JSON.stringify(payload)
    // 同一草稿网络重试沿用 requestId；编辑内容后才开启新的幂等请求。
    if (submission.current?.signature !== signature) submission.current = { signature, requestId: crypto.randomUUID() }
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const input = { ...payload, requestId: submission.current.requestId }
      if (mode.kind === 'create' && 'title' in input) await createTask(input)
      else if (mode.kind !== 'create') await taskAction(mode.task.id, 'resume', input)
      toast.success(text('submitted'))
      onClose()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      toast.error(message)
    } finally { submitting.current = false; setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className={dialogClass} data-testid="agent-task-dialog">
        <DialogHeader>
          <DialogTitle>{text(mode.kind === 'create' ? 'newTask' : mode.kind === 'handoff' ? 'handoff' : 'continue')}</DialogTitle>
          <DialogDescription>{text(description)}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          {mode.kind !== 'create' && <p className="rounded-md bg-surface-soft px-3 py-2 text-sm">{mode.task.title}<span className="mt-1 block font-mono text-[10px] text-muted-foreground">{mode.task.id}</span></p>}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-task-agent">{text('agent')}</Label>
            <select id="agent-task-agent" data-testid="agent-task-agent" required className={selectClass} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="" disabled>{text('chooseAgent')}</option>
              {candidates.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.runtime}</option>)}
            </select>
          </div>
          {mode.kind === 'create' && <div className="grid gap-1.5"><Label htmlFor="agent-task-title">{text('taskTitle')}</Label><Input id="agent-task-title" data-testid="agent-task-title" value={title} required maxLength={200} onChange={(event) => setTitle(event.target.value)} /></div>}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-task-prompt">{text(mode.kind === 'create' ? 'prompt' : 'followup')}</Label>
            <Textarea id="agent-task-prompt" data-testid="agent-task-prompt" rows={5} required={mode.kind === 'create'} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </div>
          {mode.kind === 'create' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-task-cwd">{text('cwd')}{agent && agent.runtime !== 'brain' ? ' *' : ''}</Label>
                <Input id="agent-task-cwd" data-testid="agent-task-cwd" className="font-mono text-xs" required={agent?.runtime !== 'brain'} value={cwd} onChange={(event) => setCwd(event.target.value)} aria-describedby="agent-task-cwd-help" />
                <p id="agent-task-cwd-help" className="text-xs leading-relaxed text-muted-foreground">{text(agent?.runtime === 'brain' ? 'cwdBrain' : 'cwdExternal')}</p>
              </div>
              <details className="rounded-md border border-border p-3">
                <summary className="cursor-pointer rounded text-xs font-medium text-ink-2 focus-visible:outline-2 focus-visible:outline-ring">{text('relationships')}</summary>
                <div className="mt-3 grid gap-3">
                  <div className="grid gap-1.5"><Label htmlFor="agent-task-parent">{text('parentTask')}</Label><select id="agent-task-parent" data-testid="agent-task-parent" className={selectClass} value={parentTaskId} onChange={(event) => setParentTaskId(event.target.value)}><option value="">{text('none')}</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></div>
                  <div className="grid gap-1.5"><Label htmlFor="agent-task-mission">{text('mission')}</Label><Input id="agent-task-mission" data-testid="agent-task-mission" value={missionId} onChange={(event) => setMissionId(event.target.value)} /></div>
                  <fieldset className="grid max-h-36 gap-2 overflow-y-auto"><legend className="mb-2 text-xs font-medium">{text('dependsOn')}</legend>{tasks.length ? tasks.map((task) => <label key={task.id} className="flex items-start gap-2 text-xs"><input data-testid="agent-task-dependency" value={task.id} className={checkboxClass} type="checkbox" checked={dependsOn.includes(task.id)} onChange={(event) => setDependsOn((previous) => event.target.checked ? [...previous, task.id] : previous.filter((id) => id !== task.id))} /><span className="min-w-0 break-words">{task.title}</span></label>) : <p className="text-xs text-muted-foreground">{text('noDependency')}</p>}</fieldset>
                </div>
              </details>
            </>
          ) : <p className="break-all font-mono text-xs text-muted-foreground">{text('cwd')}: {mode.task.cwd || '—'}</p>}
          {error && <p role="alert" data-testid="agent-task-error" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{text('cancel')}</Button><Button type="submit" data-testid="agent-task-submit" disabled={busy || !agent?.enabled}>{busy && <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />}{text(busy ? 'saving' : 'start')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteProfileDialog({ profile, onClose }: { profile: AgentProfile; onClose: () => void }): React.JSX.Element {
  const text = useAgentText()
  const removeProfile = useAgentStore((state) => state.removeProfile)
  const [busy, setBusy] = useState(false)
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent className={dialogClass}><DialogHeader><DialogTitle>{text('deleteAgent')} · {profile.name}</DialogTitle><DialogDescription>{text('deleteWarning')}</DialogDescription></DialogHeader><DialogFooter className="gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{text('cancel')}</Button><Button type="button" variant="destructive" data-testid="agent-profile-delete-confirm" disabled={busy} onClick={() => {
    setBusy(true)
    void removeProfile(profile.id).then(() => { toast.success(text('deleted')); onClose() }).catch(showError).finally(() => setBusy(false))
  }}>{text('deleteAgent')}</Button></DialogFooter></DialogContent></Dialog>
}
