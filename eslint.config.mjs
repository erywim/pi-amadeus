import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// eslint-plugin-react-hooks v7 ships flat presets under configs.flat with a
// legacy alias at the top level; prefer the standard (non-Compiler) set.
const hooksFlat = reactHooks.configs.flat ?? reactHooks.configs
const hooksRecommended = hooksFlat.recommended ?? hooksFlat['recommended-latest']

export default tseslint.config(
  {
    ignores: [
      '**/out/**',
      '**/release/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/src/renderer/public/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/desktop/src/renderer/src/**/*.{ts,tsx}'],
    ...hooksRecommended,
    plugins: {
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactRefresh.configs.vite.rules,
      // 允许 router/cva variants 等常量导出（否则 badge.tsx/button.tsx/router.tsx 报错）
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    // launch.mjs 等构建脚本运行于 Node，提供 process/console 全局
    files: ['apps/desktop/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly'
      }
    }
  },
  {
    // Node Relay 服务运行于 Node 22+；Cloudflare worker/APNs/FCM 也提供 Web API 全局。
    files: ['services/relay/index.mjs', 'services/relay/shared.mjs', 'services/relay/apns.mjs', 'services/relay/fcm.mjs', 'services/relay/cloudflare/worker.mjs', 'services/relay/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        ReadableStream: 'readonly',
        WebSocketPair: 'readonly',
        crypto: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-this-alias': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    // E2E/调试脚本运行于 Node（fetch/WebSocket 为 Node 22+ 全局）
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        WebSocket: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    }
  }
)
