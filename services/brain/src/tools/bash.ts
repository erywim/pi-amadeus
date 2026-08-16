import { spawn } from 'node:child_process'
import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { ToolDeniedError } from './confirm.ts'
import { blockReason, checkBashSafety } from './safety.ts'

/**
 * bash 本机命令执行（参考 coding 模块的 bash 工具，按 brain 风格简化）：
 * 确认握手（execute 内 await promise，由 /api/tool-confirm 放行）→
 * spawn 执行 → 输出尾 16KB 快照节流上屏 → 超时/中止杀进程树。
 * 安全三层：beforeToolCall 黑名单拦截（agentTurn 装配）→ 入口二次校验 →
 * 确认卡人工授权。win32 走 cmd.exe /d /s /c。
 */

export const bashToolSchema = Type.Object({
  command: Type.String({ description: '要执行的 shell 命令' }),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: '超时秒数，默认 30' }))
})

type BashArgs = Static<typeof bashToolSchema>

/** 输出保留尾部的字节上限 */
const MAX_OUTPUT_BYTES = 16 * 1024
/** 部分输出上屏节流间隔 */
const UPDATE_INTERVAL_MS = 100

export function createBashTool(opts: {
  cwd: string
  /** 请求用户确认；拒绝/超时/中止以 ToolDeniedError reject */
  confirmRequest: (toolCallId: string, command: string) => Promise<boolean>
}): AgentTool<typeof bashToolSchema> {
  return {
    name: 'bash',
    label: '执行命令',
    description:
      '在用户电脑上执行 shell 命令（Windows cmd）。适合查文件、开目录、读写本地内容等本机操作。' +
      '每次执行前会请用户确认；危险命令会被安全策略拦截。',
    parameters: bashToolSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, params: BashArgs, signal?: AbortSignal, onUpdate?) => {
      // 纵深防御：入口二次黑名单校验（正常路径已被 beforeToolCall 拦截）
      const check = checkBashSafety(params.command)
      if (!check.allowed) throw new ToolDeniedError('blocked', blockReason(check.reason))

      const approved = await opts.confirmRequest(toolCallId, params.command)
      if (!approved) throw new ToolDeniedError('user_denied', '用户拒绝了执行该命令')

      const timeoutMs = Math.floor((params.timeout ?? 30) * 1000)
      const startedAt = Date.now()
      const out = await runCommand(params.command, {
        cwd: opts.cwd,
        timeoutMs,
        signal,
        onOutput: (snapshot) => {
          onUpdate?.({ content: [{ type: 'text', text: snapshot }], details: {} })
        }
      })

      if (out.exitCode !== 0) {
        throw new Error(`${out.output || '(无输出)'}\n\n[exit code ${out.exitCode}]`)
      }
      return {
        content: [{ type: 'text', text: out.output || '(无输出)' }],
        details: { exitCode: 0, durationMs: Date.now() - startedAt }
      }
    }
  }
}

interface RunResult {
  exitCode: number | null
  output: string
}

/** 执行命令：输出保留尾 16KB，100ms 节流快照回调；超时/中止杀进程树 */
function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onOutput: (snapshot: string) => void }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
            cwd: opts.cwd,
            windowsHide: true
          })
        : spawn('/bin/bash', ['-c', command], { cwd: opts.cwd })

    let stdout = ''
    let stderr = ''
    let lastUpdate = 0

    const onChunk = (chunk: Buffer, isStdout: boolean): void => {
      if (isStdout) stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      // 只保留尾部（stdout + stderr 各半预算），防输出刷爆内存
      if (stdout.length > MAX_OUTPUT_BYTES / 2) stdout = stdout.slice(-MAX_OUTPUT_BYTES / 2)
      if (stderr.length > MAX_OUTPUT_BYTES / 2) stderr = stderr.slice(-MAX_OUTPUT_BYTES / 2)
      const now = Date.now()
      if (now - lastUpdate >= UPDATE_INTERVAL_MS) {
        lastUpdate = now
        opts.onOutput(snapshot())
      }
    }
    const snapshot = (): string => (stderr ? `${stdout}${stdout ? '\n' : ''}${stderr}` : stdout)

    child.stdout?.on('data', (c: Buffer) => onChunk(c, true))
    child.stderr?.on('data', (c: Buffer) => onChunk(c, false))

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = (): void => {
      killTree(child.pid)
      finish(() => reject(new ToolDeniedError('aborted', '回合已中止，命令已终止')))
    }

    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(() => reject(new Error(`命令执行超时（${Math.floor(opts.timeoutMs / 1000)}s），已终止`)))
    }, opts.timeoutMs)

    child.on('error', (error) => {
      finish(() => reject(new Error(`命令启动失败：${error.message}`)))
    })
    child.on('close', (code) => {
      finish(() => resolve({ exitCode: code, output: snapshot() }))
    })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 杀进程树：win32 用 taskkill /T /F；posix 直接 SIGKILL（v1 简化） */
function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // 进程可能已退出
  }
}
