import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UserConfig } from '@pi-amadeus/shared'
import {
  fetchUserConfig,
  saveUserConfig,
  type ApiKeyStatus
} from '@renderer/lib/api'
import i18n from '@renderer/i18n'

export type UiLanguage = 'zh' | 'en' | 'ja'
/** 外观主题：paper=暖纸浅色（默认） / cyber=dark cyber 深色 */
export type UiTheme = 'paper' | 'cyber'
/** 启动默认模式（顶栏 tab 的目标路由） */
export type DefaultMode = 'companion' | 'text'

/** 表单初值：仅作加载前的占位；真正配置以大脑服务 SQLite 为单一来源 */
const FORM_PLACEHOLDER: UserConfig = {
  provider: {
    baseUrl: '',
    apiKey: '',
    model: '',
    proxy: ''
  },
  outputLanguage: 'zh',
  systemPrompt: ''
}

interface SettingsState {
  language: UiLanguage
  theme: UiTheme
  defaultMode: DefaultMode
  /** 陪伴模式进入时默认静音语音播报 */
  defaultMute: boolean
  aiConfig: UserConfig
  /** 生效密钥状态（default=回落 .env 默认密钥 / custom=用户自定义 / none=未配置） */
  keyStatus: ApiKeyStatus
  configLoaded: boolean
  setLanguage: (language: UiLanguage) => void
  setTheme: (theme: UiTheme) => void
  setDefaultMode: (mode: DefaultMode) => void
  setDefaultMute: (muted: boolean) => void
  /** 从大脑服务加载用户配置到表单 */
  loadAiConfig: (userId: string) => Promise<void>
  /** 保存表单到大脑服务（apiKey 留空 = 保持服务端已有密钥） */
  saveAiConfig: (userId: string, patch: UserConfig) => Promise<void>
}

/**
 * 语言偏好保留在本地（UI 偏好，非 AI 配置）；AI 配置以服务端 SQLite
 * user_configs 为单一来源，此处只作表单缓存，不再持久化到 localStorage
 * （消除原版 localStorage / 数据库 / 进程内 dict 三处重复存储的缺陷）。
 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'zh',
      theme: 'paper',
      defaultMode: 'companion',
      defaultMute: false,
      aiConfig: FORM_PLACEHOLDER,
      keyStatus: 'none',
      configLoaded: false,
      setLanguage: (language) => {
        set({ language })
        void i18n.changeLanguage(language)
      },
      setTheme: (theme) => set({ theme }),
      setDefaultMode: (defaultMode) => set({ defaultMode }),
      setDefaultMute: (defaultMute) => set({ defaultMute }),
      loadAiConfig: async (userId) => {
        const { config, keyStatus } = await fetchUserConfig(userId)
        // 密钥不回填表单：留空提交即保持服务端密钥不变
        set({
          aiConfig: { ...config, provider: { ...config.provider, apiKey: '' } },
          keyStatus,
          configLoaded: true
        })
      },
      saveAiConfig: async (userId, patch) => {
        const { config, keyStatus } = await saveUserConfig(userId, patch)
        set({
          aiConfig: { ...config, provider: { ...config.provider, apiKey: '' } },
          keyStatus,
          configLoaded: true
        })
      }
    }),
    {
      name: 'amadeus_settings',
      partialize: (s) => ({
        language: s.language,
        theme: s.theme,
        defaultMode: s.defaultMode,
        defaultMute: s.defaultMute
      })
    }
  )
)

/** 应用启动时把持久化的语言同步给 i18n（初始检测仍由 detector 完成） */
export function syncPersistedLanguage(): void {
  const { language } = useSettingsStore.getState()
  if (i18n.resolvedLanguage !== language) {
    void i18n.changeLanguage(language)
  }
}
