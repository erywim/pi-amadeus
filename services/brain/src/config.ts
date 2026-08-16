import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

// 本地 .env（存在时加载；process.loadEnvFile 不覆盖已有环境变量）
const envPath = resolve(import.meta.dirname, '../.env')
if (existsSync(envPath)) loadEnvFile(envPath)

const env = (name: string, fallback = ''): string => process.env[name] ?? fallback

export interface BrainConfig {
  port: number
  db: { host: string; port: number; database: string; user: string; password: string }
  llm: { apiKey: string; baseUrl: string; model: string }
  whisper: { apiKey: string; baseUrl: string; model: string; proxy: string }
  fish: { apiKey: string; voice: string; endpoint: string; model: string; sampleRate: number; proxy: string }
  feishu: { enabled: boolean; appId: string; appSecret: string; domain: 'feishu' | 'lark' }
}

export function loadConfig(): BrainConfig {
  return {
    port: Number(env('PORT', '3002')) || 3002,
    db: {
      host: env('PGHOST', '127.0.0.1'),
      port: Number(env('PGPORT', '5432')) || 5432,
      database: env('PGDATABASE', 'amadeus'),
      user: env('PGUSER', 'amadeus'),
      password: env('PGPASSWORD', 'amadeus')
    },
    llm: {
      apiKey: env('LLM_API_KEY'),
      baseUrl: env('LLM_BASE_URL', 'https://api.deepseek.com/v1'),
      model: env('AI_MODEL', 'deepseek-v4-pro')
    },
    whisper: {
      apiKey: env('WHISPER_API_KEY'),
      baseUrl: env('WHISPER_BASE_URL'),
      model: env('WHISPER_MODEL', 'whisper-large-v3'),
      proxy: env('WHISPER_PROXY')
    },
    fish: {
      apiKey: env('FISH_AUDIO_API_KEY'),
      voice: env('FISH_AUDIO_VOICE', '09803a7b68fd41d7b4171c63ce06243b'),
      endpoint: env('TTS_ENDPOINT_URL', 'https://api.fish.audio/v1/tts'),
      model: env('TTS_MODEL', 's2.1-pro'),
      sampleRate: 32000,
      proxy: env('FISH_AUDIO_PROXY')
    },
    feishu: {
      enabled: env('FEISHU_ENABLED', 'false') === 'true',
      appId: env('FEISHU_APP_ID'),
      appSecret: env('FEISHU_APP_SECRET'),
      domain: env('FEISHU_DOMAIN', 'feishu') === 'lark' ? 'lark' : 'feishu'
    }
  }
}
