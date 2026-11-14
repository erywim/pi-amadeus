import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { THINKING_LEVELS, type OutputLanguage, type ThinkingLevel, type UserConfig } from '@pi-amadeus/shared'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { ProviderSection } from './ProviderSection'

/** AI 配置表单：读写大脑服务 /api/config/:userId（服务端 SQLite 单一来源） */
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
  // 用户是否改过表单：改过之后，迟到的 loadAiConfig 回填不得覆盖用户输入
  const dirtyRef = useRef(false)

  function updateForm(next: UserConfig): void {
    dirtyRef.current = true
    setForm(next)
  }

  // 表单与服务端配置同步（首屏加载；store 更新时回填；用户已改动则跳过）
  useEffect(() => {
    if (!dirtyRef.current) {
      setForm(aiConfig)
    }
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
      // 保存成功：回到"未改动"状态，并用服务端返回的最新配置回填（密钥不回填）
      dirtyRef.current = false
      setForm(useSettingsStore.getState().aiConfig)
      toast.success(t('settings.ai.savedHint'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-xl">
      <ProviderSection />
      <div className="border-t border-border pt-6">
        <h2 className="text-base font-semibold">{t('settings.ai.title')}</h2>
        <p className="mb-1 mt-1 text-xs text-muted-foreground">{t('settings.ai.desc')}</p>
        <p className="mb-6 text-xs text-muted-foreground">{t('settings.ai.fallbackHint')}</p>
      </div>
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
            onChange={(e) => updateForm({ ...form, provider: { ...form.provider, baseUrl: e.target.value } })}
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
            onChange={(e) => updateForm({ ...form, provider: { ...form.provider, apiKey: e.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-model">{t('settings.ai.model')}</Label>
          <Input
            id="ai-model"
            value={form.provider.model}
            placeholder={t('settings.ai.modelPlaceholder')}
            onChange={(e) => updateForm({ ...form, provider: { ...form.provider, model: e.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-proxy">{t('settings.ai.proxy')}</Label>
          <Input
            id="ai-proxy"
            value={form.provider.proxy ?? ''}
            placeholder={t('settings.ai.proxyPlaceholder')}
            onChange={(e) => updateForm({ ...form, provider: { ...form.provider, proxy: e.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-thinking-level">{t('settings.ai.thinkingLevel')}</Label>
          <Select
            value={form.provider.thinkingLevel ?? 'off'}
            onValueChange={(v) =>
              updateForm({
                ...form,
                provider: { ...form.provider, thinkingLevel: v as ThinkingLevel }
              })
            }
          >
            <SelectTrigger id="ai-thinking-level" data-testid="ai-thinking-level" className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THINKING_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`settings.ai.thinking.${level}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('settings.ai.thinkingHint')}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ai-context-window">{t('settings.ai.contextWindow')}</Label>
            <Input
              id="ai-context-window"
              data-testid="ai-context-window"
              type="number"
              min={0}
              value={form.provider.contextWindow ?? 0}
              onChange={(e) =>
                updateForm({
                  ...form,
                  provider: { ...form.provider, contextWindow: Math.max(0, Number(e.target.value) || 0) }
                })
              }
            />
            <p className="text-xs text-muted-foreground">{t('settings.ai.contextWindowHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-max-tokens">{t('settings.ai.maxTokens')}</Label>
            <Input
              id="ai-max-tokens"
              data-testid="ai-max-tokens"
              type="number"
              min={0}
              value={form.provider.maxTokens ?? 0}
              onChange={(e) =>
                updateForm({
                  ...form,
                  provider: { ...form.provider, maxTokens: Math.max(0, Number(e.target.value) || 0) }
                })
              }
            />
            <p className="text-xs text-muted-foreground">{t('settings.ai.maxTokensHint')}</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-system-prompt">{t('settings.ai.systemPrompt')}</Label>
          <Textarea
            id="ai-system-prompt"
            rows={6}
            className="font-mono text-xs"
            value={form.systemPrompt}
            placeholder={t('settings.ai.systemPromptPlaceholder')}
            onChange={(e) => updateForm({ ...form, systemPrompt: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>{t('settings.ai.outputLanguage')}</Label>
          <Select
            value={form.outputLanguage}
            onValueChange={(v) => updateForm({ ...form, outputLanguage: v as OutputLanguage })}
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
            onCheckedChange={(checked) => updateForm({ ...form, tools: { enabled: checked } })}
          />
        </div>
        <Button onClick={save} disabled={!userId || !configLoaded || saving}>
          {t('settings.ai.save')}
        </Button>
      </div>
    </div>
  )
}
