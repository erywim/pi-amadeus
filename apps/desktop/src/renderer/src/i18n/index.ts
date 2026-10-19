import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import zh from './locales/zh.json'
import en from './locales/en.json'
import ja from './locales/ja.json'

// 原生托盘/右键菜单在主进程渲染，语言跟随界面（init 时也会触发一次）。
// 纯浏览器调试环境（scripts/cdp-chrome.mjs）没有 preload，api 不存在
i18n.on('languageChanged', (lng) => {
  window.api?.setUiLanguage(lng)
})

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
      ja: { translation: ja }
    },
    fallbackLng: 'zh',
    supportedLngs: ['zh', 'en', 'ja'],
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'amadeus_lang'
    }
  })

export default i18n
