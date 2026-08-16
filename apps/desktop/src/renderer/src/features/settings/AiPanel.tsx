import * as React from 'react'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import type { OutputLanguage, UserConfig } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'

/** AI 配置表单：读写大脑服务 /api/config/:userId（Postgres 单一来源） */
export function AiPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const userId = useSessionStore((s) => s.userId)
  const aiConfig = useSettingsStore((s) => s.aiConfig)
  const keyStatus = useSettingsStore((s) => s.keyStatus)
  const configLoaded = useSettingsStore((s) => s.configLoaded)
  const loadAiConfig = useSettingsStore((s) => s.loadAiConfig)
  const saveAiConfig = useSettingsStore((s) => s.saveAiConfig)
  const [form, setForm] = useState<UserConfig>(aiConfig)
  const [saving, setSaving] = useState(false)

  // 表单与服务端配置同步（首屏加载；store 更新时回填）
  useEffect(() => {
    setForm(aiConfig)
  }, [aiConfig])

  useEffect(() => {
    if (userId) {
      loadAiConfig(userId).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    }
  }, [userId, loadAiConfig])

  async function save(): Promise<void> {
    if (!userId) return
    setSaving(true)
    try {
      await saveAiConfig(userId, form)
      toast.success(t('settings.ai.savedHint'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-xl">
      <h2 className="text-base font-semibold">{t('settings.ai.title')}</h2>
      <p className="mb-6 mt-1 text-xs text-muted-foreground">{t('settings.ai.desc')}</p>
      {!userId && (
        <p className="mb-4 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          {t('settings.ai.loginRequired')}
        </p>
      )}
      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="ai-base-url">{t('settings.ai.baseUrl')}</Label>
          <Input
            id="ai-base-url"
            value={form.provider.baseUrl}
            placeholder={t('settings.ai.baseUrlPlaceholder')}
            onChange={(e) => setForm({ ...form, provider: { ...form.provider, baseUrl: e.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-api-key">{t('settings.ai.apiKey')}</Label>
          <Input
            id="ai-api-key"
            type="password"
            value={form.provider.apiKey}
            placeholder={
              keyStatus === 'default'
                ? t('settings.ai.keyDefault')
                : keyStatus === 'custom'
                  ? t('settings.ai.keySaved')
                  : t('settings.ai.apiKeyPlaceholder')
            }
            onChange={(e) => setForm({ ...form, provider: { ...form.provider, apiKey: e.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-model">{t('settings.ai.model')}</Label>
          <Input
            id="ai-model"
            value={form.provider.model}
            placeholder={t('settings.ai.modelPlaceholder')}
            onChange={(e) => setForm({ ...form, provider: { ...form.provider, model: e.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-proxy">{t('settings.ai.proxy')}</Label>
          <Input
            id="ai-proxy"
            value={form.provider.proxy ?? ''}
            placeholder={t('settings.ai.proxyPlaceholder')}
            onChange={(e) => setForm({ ...form, provider: { ...form.provider, proxy: e.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-system-prompt">{t('settings.ai.systemPrompt')}</Label>
          <Textarea
            id="ai-system-prompt"
            rows={6}
            className="font-mono text-xs"
            value={form.systemPrompt}
            placeholder={t('settings.ai.systemPromptPlaceholder')}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>{t('settings.ai.outputLanguage')}</Label>
          <Select
            value={form.outputLanguage}
            onValueChange={(v) => setForm({ ...form, outputLanguage: v as OutputLanguage })}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">{t('settings.language.zh')}</SelectItem>
              <SelectItem value="en">{t('settings.language.en')}</SelectItem>
              <SelectItem value="ja">{t('settings.language.ja')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{t('settings.ai.toolsEnable')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.ai.toolsDesc')}</p>
          </div>
          <Switch
            checked={form.tools?.enabled ?? true}
            onCheckedChange={(checked) => setForm({ ...form, tools: { enabled: checked } })}
          />
        </div>
        <Button onClick={save} disabled={!userId || !configLoaded || saving}>
          {t('settings.ai.save')}
        </Button>
      </div>
    </div>
  )
}
