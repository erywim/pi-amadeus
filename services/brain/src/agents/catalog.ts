import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import type { AgentRuntime, DiscoveredAgent } from '@pi-amadeus/shared'

type CliRuntime = Exclude<AgentRuntime, 'brain' | 'custom'>
interface RuntimeSpec {
  name: string
  args: string[]
  promptMode: 'stdin' | 'argument'
}

/** 不添加跳过权限或沙箱的参数；CLI 的原生权限策略仍然有效。 */
export const AGENT_CATALOG: Record<CliRuntime, RuntimeSpec> = {
  claude: { name: 'Claude Code', args: ['--print', '--output-format', 'text'], promptMode: 'stdin' },
  codex: { name: 'Codex', args: ['exec', '--color', 'never', '-'], promptMode: 'stdin' },
  opencode: { name: 'OpenCode', args: ['run', '--', '{prompt}'], promptMode: 'argument' },
  pi: { name: 'Pi', args: ['--print'], promptMode: 'stdin' },
  gemini: { name: 'Gemini CLI', args: ['--prompt', '{prompt}'], promptMode: 'argument' },
  aider: { name: 'Aider', args: ['--message', '{prompt}'], promptMode: 'argument' },
  goose: { name: 'Goose', args: ['run', '--text', '{prompt}'], promptMode: 'argument' },
  qwen: { name: 'Qwen Code', args: ['--prompt', '{prompt}'], promptMode: 'argument' },
  copilot: { name: 'GitHub Copilot', args: ['--prompt', '{prompt}'], promptMode: 'argument' }
}

/** 不把 brain 的 key、飞书凭据或进程控制变量广播给用户配置的可执行文件。 */
export function agentEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', TERM: 'dumb' }
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

export async function executablePath(command: string): Promise<string | null> {
  const names = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.COM').split(';').filter((ext) => !/\.cmd|\.bat/i.test(ext))]
    : ['']
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? '').split(delimiter).filter((path) => isAbsolute(path))
      .flatMap((path) => names.map((ext) => join(path, command + ext)))
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate)
      if (!(await stat(path)).isFile()) continue
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)) continue
      await access(path, constants.X_OK)
      return path
    } catch { /* PATH 中不存在或不可执行的候选项不是已安装的 CLI。 */ }
  }
  return null
}

const CACHE_MS = 60_000
let cache: { key: string; at: number; result: Promise<DiscoveredAgent[]> } | null = null

function installedVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 16_384, windowsHide: true, env: agentEnvironment() }, (error, stdout, stderr) => {
      const version = (stdout || stderr).trim().split(/\r?\n/)[0]?.slice(0, 200) || null
      resolve(error ? null : version)
    })
  })
}

/** 只检查 PATH 与版本，不安装、不认证、不改写外部 CLI 的配置。 */
export async function discoverAgents(): Promise<DiscoveredAgent[]> {
  const key = `${process.env.PATH ?? ''}\0${process.env.PATHEXT ?? ''}\0${process.env.HOME ?? ''}`
  if (!cache || cache.key !== key || Date.now() - cache.at > CACHE_MS) {
    const result = (async (): Promise<DiscoveredAgent[]> => {
      const entries = await Promise.all(Object.entries(AGENT_CATALOG).map(async ([runtime, spec]): Promise<DiscoveredAgent> => {
        const path = await executablePath(runtime)
        return {
          runtime: runtime as CliRuntime, name: spec.name, installed: path !== null,
          path, version: path ? await installedVersion(path) : null, supported: true,
          note: path ? '沿用 CLI 本机认证和原生权限；无头模式无法交互的权限请求会由 CLI 拒绝或等待至任务超时。' : '未在 PATH 找到；请自行安装后刷新，不会自动安装。'
        }
      }))
      const acpx = await executablePath('acpx')
      if (acpx) entries.push({ runtime: 'custom', name: 'acpx', installed: true, path: acpx, version: await installedVersion(acpx), supported: false, note: '仅发现 ACP 桥接器；未确认启动协议，不会作为原生适配器执行。' })
      return [{ runtime: 'brain', name: 'Amadeus', installed: true, path: null, version: null, supported: true, note: '内置隔离工具回合，复用本机已配置的模型服务。' }, ...entries]
    })()
    // 缓存未命中 → 共用一次有超时的探测，避免每次看板刷新都启动版本检查进程。
    cache = { key, at: Date.now(), result }
  }
  return structuredClone(await cache.result)
}
