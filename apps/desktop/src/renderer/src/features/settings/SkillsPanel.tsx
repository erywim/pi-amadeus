import * as React from 'react'
import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Sparkles } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { fetchSkills, setSkillEnabledApi, type SkillInfo } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'

/**
 * skill 管理：列表 / 启停 / 打开目录。
 * skill 以文件形式存在（SKILL.md + YAML frontmatter），存放于服务端
 * skills 目录；启停状态持久化在服务端（.amadeus-state.json）。
 */
export function SkillsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [dir, setDir] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const list = await fetchSkills()
      setDir(list.dir)
      setSkills(list.skills)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function toggle(skill: SkillInfo, enabled: boolean): Promise<void> {
    setBusy(skill.name)
    try {
      await setSkillEnabledApi(skill.name, enabled)
      setSkills((list) => list.map((s) => (s.name === skill.name ? { ...s, enabled } : s)))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function openDir(): Promise<void> {
    const error = await window.api.openPath(dir)
    if (error) toast.error(`${t('settings.skills.openFailed')}：${error}`)
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t('settings.skills.title')}</h2>
          <p className="mb-6 mt-1 text-xs text-muted-foreground">{t('settings.skills.desc')}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!dir} onClick={() => void openDir()}>
          <FolderOpen className="size-3.5" />
          {t('settings.skills.openDir')}
        </Button>
      </div>

      <p className="mb-4 break-all rounded-md border border-border bg-card px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {dir || '…'}
      </p>

      <div className="space-y-3">
        {loaded && skills.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('settings.skills.empty')}</p>
        )}
        {skills.map((skill) => (
          <div key={skill.name} className="rounded-md border border-border bg-card px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="size-3.5 shrink-0 text-cyber-cyan" />
                  <span className="font-mono text-[13px] font-semibold">{skill.name}</span>
                  {skill.disableModelInvocation && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t('settings.skills.manualOnly')}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{skill.description}</p>
                <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground/60">
                  {skill.filePath}
                </p>
              </div>
              <Switch
                checked={skill.enabled}
                disabled={busy === skill.name}
                onCheckedChange={(checked) => void toggle(skill, checked)}
              />
            </div>
          </div>
        ))}
      </div>

      <Button variant="ghost" size="sm" className="mt-4" onClick={() => void load()}>
        <RefreshCw className="size-3.5" />
        {t('settings.skills.refresh')}
      </Button>
    </div>
  )
}
