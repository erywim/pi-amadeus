import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

// 本地 .env（存在时加载；process.loadEnvFile 不覆盖已有环境变量）
const envPath = resolve(import.meta.dirname, '../.env')
if (existsSync(envPath)) loadEnvFile(envPath)

const env = (name: string, fallback = ''): string => process.env[name] ?? fallback

export interface BrainConfig {
  port: number
  /** 默认只监听 IPv4 loopback；只有显式 BRAIN_HOST 才扩展监听范围 */
  host: string
  httpAccess: {
    allowedHosts: string[]
    allowedOrigins: string[]
    allowFileOrigin: boolean
    adminToken: string
  }
  /** SQLite 单文件路径（自动建库建表，无需数据库服务） */
  db: { path: string }
  llm: { apiKey: string; baseUrl: string; model: string }
  whisper: { apiKey: string; baseUrl: string; model: string; proxy: string }
  fish: { apiKey: string; voice: string; endpoint: string; model: string; sampleRate: number; proxy: string }
  feishu: { enabled: boolean; appId: string; appSecret: string; domain: 'feishu' | 'lark' }
  tools: {
    tavilyKey: string
    /** 独立搜索/网页代理；未设时继承实际模型目标的代理，空字符串显式直连。 */
    searchProxy?: string
    confirmTimeoutMs: number
    bashCwd: string
    computerTimeoutMs: number
    /** 搜索端点覆盖（未设置的引擎走官方地址）；E2E 用它指向本地 mock */
    searchEndpoints: Partial<Record<'tavily' | 'bing' | 'so' | 'sogou' | 'duckduckgo', string>>
  }
  /** 只读工作区浏览（文件树 / Git 状态）的根目录；默认与 bash 工具工作目录一致 */
  workspace: { root: string }
  /** skill 文件目录（SKILL.md 形式，复用 pi loadSkills 加载） */
  skills: { dir: string }
  /** 消息附件（图片/语音/文件）落盘目录 */
  media: { dir: string }
}

export function loadConfig(): BrainConfig {
  /**
   * 仓库根：本文件在 services/brain/src，向上三级。
   * 不用 process.cwd()——npm workspace 脚本的 cwd 是 services/brain，
   * 那会把「工作区」与助手终端都钉在大脑包目录里（文件树只有源码、
   * 改动卡永远为空、@ 文件引用搜不到用户仓库）。
   */
  const repoRoot = resolve(import.meta.dirname, '../../..')
  const bashCwd = resolve(env('BASH_TOOL_CWD') || repoRoot)
  return {
    port: Number(env('PORT', '3002')) || 3002,
    host: env('BRAIN_HOST').trim() || '127.0.0.1',
    httpAccess: {
      // 配置列表是精确值，不支持通配符；安全配置只读环境变量，不写入用户配置/密钥。
      allowedHosts: env('BRAIN_ALLOWED_HOSTS').split(',').map((host) => host.trim()).filter(Boolean),
      allowedOrigins: env('BRAIN_ALLOWED_ORIGINS',
        'http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173'
      ).split(',').map((origin) => origin.trim()).filter(Boolean),
      allowFileOrigin: env('BRAIN_ALLOW_FILE_ORIGIN', 'true') === 'true',
      adminToken: env('BRAIN_ADMIN_TOKEN')
    },
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
      ...(process.env.SEARCH_PROXY !== undefined ? { searchProxy: env('SEARCH_PROXY').trim() } : {}),
      confirmTimeoutMs: Number(env('TOOL_CONFIRM_TIMEOUT_MS', '60000')) || 60000,
      bashCwd,
      computerTimeoutMs: Math.min(120_000, Math.max(5_000, Number(env('COMPUTER_TIMEOUT_MS', '30000')) || 30_000)),
      // 引擎端点可用环境变量覆盖（镜像站 / 自建代理 / E2E 本地 mock）；
      // 留空时 search.ts 用官方地址，不把默认值复制到这里
      searchEndpoints: Object.fromEntries(
        (
          [
            ['tavily', 'SEARCH_TAVILY_URL'],
            ['bing', 'SEARCH_BING_URL'],
            ['so', 'SEARCH_SO_URL'],
            ['sogou', 'SEARCH_SOGOU_URL'],
            ['duckduckgo', 'SEARCH_DUCKDUCKGO_URL']
          ] as const
        )
          .map(([engine, key]) => [engine, env(key)] as const)
          .filter(([, url]) => url.length > 0)
      )
    },
    workspace: {
      /**
       * 工作区根目录：显式 WORKSPACE_DIR 优先，否则用仓库根。
       *
       * 不能默认成 bashCwd：npm workspace 脚本的 cwd 是 services/brain，
       * 那样文件树、`@` 文件引用、回合改动卡都会指向大脑包目录而不是用户仓库，
       * 表现成「工作区里只有 20 个源码文件、改动卡永远为空」。
       * 仓库根 = 本文件所在目录（services/brain/src）向上三级。
       */
      root: resolve(env('WORKSPACE_DIR') || repoRoot)
    },
    skills: {
      // 默认 services/brain/skills/；目录不存在时 loadSkills 静默跳过
      dir: env('SKILLS_DIR', resolve(import.meta.dirname, '../skills'))
    },
    media: {
      dir: env('MEDIA_DIR') ? resolve(env('MEDIA_DIR')) : resolve(import.meta.dirname, '../data/media')
    }
  }
}
