import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

// 本地 .env（存在时加载；process.loadEnvFile 不覆盖已有环境变量）
const envPath = resolve(import.meta.dirname, '../.env')
if (existsSync(envPath)) loadEnvFile(envPath)

const env = (name: string, fallback = ''): string => process.env[name] ?? fallback

export interface BrainConfig {
  port: number
  /** SQLite 单文件路径（自动建库建表，无需数据库服务） */
  db: { path: string }
  llm: { apiKey: string; baseUrl: string; model: string }
  whisper: { apiKey: string; baseUrl: string; model: string; proxy: string }
  fish: { apiKey: string; voice: string; endpoint: string; model: string; sampleRate: number; proxy: string }
  feishu: { enabled: boolean; appId: string; appSecret: string; domain: 'feishu' | 'lark' }
  tools: { tavilyKey: string; confirmTimeoutMs: number; bashCwd: string }
  /** skill 文件目录（SKILL.md 形式，复用 pi loadSkills 加载） */
  skills: { dir: string }
}

export function loadConfig(): BrainConfig {
  return {
    port: Number(env('PORT', '3002')) || 3002,
    db: {
      // 默认 services/brain/data/amadeus.db；DB_PATH 相对路径按启动目录解析
      path: env('DB_PATH') ? resolve(env('DB_PATH')) : resolve(import.meta.dirname, '../data/amadeus.db')
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
    },
    tools: {
      tavilyKey: env('TAVILY_API_KEY'),
      confirmTimeoutMs: Number(env('TOOL_CONFIRM_TIMEOUT_MS', '60000')) || 60000,
      bashCwd: env('BASH_TOOL_CWD', process.cwd())
    },
    skills: {
      // 默认 services/brain/skills/；目录不存在时 loadSkills 静默跳过
      dir: env('SKILLS_DIR', resolve(import.meta.dirname, '../skills'))
    }
  }
}
