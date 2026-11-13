import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ConversionFormat } from '@pi-amadeus/shared'

const COMMAND_TIMEOUT_MS = 120_000

export class ExternalConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExternalConversionError'
  }
}

interface CommandResult {
  stdout: string
  stderr: string
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin'
}

function commandResult(command: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      child.kill()
      finish(() => reject(new ExternalConversionError('转换已取消')))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new ExternalConversionError('外部转换引擎超时')))
    }, COMMAND_TIMEOUT_MS)
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      if (target === 'stdout') stdout += chunk.toString('utf8').slice(0, 4_000)
      else stderr += chunk.toString('utf8').slice(0, 4_000)
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new ExternalConversionError(error.code === 'ENOENT' ? '未找到外部转换引擎' : error.message)))
    })
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new ExternalConversionError(stderr.trim() || `${command} 退出码 ${String(code)}`))
      })
    })
  })
}

async function outputFileOf(dir: string, expectedExtension?: string): Promise<string> {
  const entries = (await readdir(dir)).filter((entry) => !entry.startsWith('.'))
  const candidates = expectedExtension ? entries.filter((entry) => entry.toLowerCase().endsWith(expectedExtension)) : entries
  const name = (candidates.length > 0 ? candidates : entries)[0]
  if (!name) throw new ExternalConversionError('外部转换引擎未生成结果')
  return join(dir, name)
}

async function ffmpegConversion(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-convert-'))
  try {
    const input = join(dir, `input${safeExtension(sourceName)}`)
    const output = join(dir, `output.${target === 'gif-video' ? 'gif' : target}`)
    await writeFile(input, bytes)
    await commandResult('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, output], signal)
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function pdfRaster(
  bytes: Uint8Array,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-pdf-'))
  try {
    const input = join(dir, 'input.pdf')
    const prefix = join(dir, 'page')
    const formatArgs: string[] = target === 'jpg' ? ['-jpeg'] : target === 'tiff' ? ['-tiff'] : ['-png']
    await writeFile(input, bytes)
    await commandResult('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-r', '150', ...formatArgs, input, prefix], signal)
    const output = await outputFileOf(dir, target === 'jpg' ? '.jpg' : `.${target}`)
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function libreOfficeConversion(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-office-'))
  const profile = join(dir, 'profile')
  try {
    const input = join(dir, `input${safeExtension(sourceName)}`)
    await writeFile(input, bytes)
    const profileUrl = `file://${profile}`
    const command = process.platform === 'win32' ? 'soffice.exe' : 'soffice'
    await commandResult(
      command,
      ['--headless', `-env:UserInstallation=${profileUrl}`, '--convert-to', target, '--outdir', dir, input],
      signal
    )
    const output = await outputFileOf(dir, `.${target}`)
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function pandocConversion(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-pandoc-'))
  try {
    const input = join(dir, `input${safeExtension(sourceName)}`)
    const output = join(dir, `output.${target}`)
    await writeFile(input, bytes)
    await commandResult('pandoc', [input, '-o', output], signal)
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function tesseractOcr(bytes: Uint8Array, sourceName: string, signal?: AbortSignal): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-ocr-'))
  try {
    const input = join(dir, `input${safeExtension(sourceName)}`)
    await writeFile(input, bytes)
    const result = await commandResult('tesseract', [input, 'stdout', '-l', 'eng'], signal)
    return new TextEncoder().encode(result.stdout)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function externalConversion(
  bytes: Uint8Array,
  sourceName: string,
  source: ConversionFormat,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (signal?.aborted) throw new ExternalConversionError('转换已取消')
  if (source === 'pdf' && ['png', 'jpg', 'tiff'].includes(target)) return pdfRaster(bytes, target, signal)
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'gif-video'].includes(source)) {
    return ffmpegConversion(bytes, sourceName, target, signal)
  }
  if (['png', 'jpg', 'webp', 'tiff', 'gif', 'avif'].includes(source) && ['txt', 'md'].includes(target)) {
    return tesseractOcr(bytes, sourceName, signal)
  }
  if (['doc', 'docx', 'odt', 'rtf', 'wps', 'wpt', 'wpd', 'ofd', 'xls', 'xlsx', 'xlsm', 'ods', 'et', 'ett', 'ppt', 'pptx', 'odp', 'dps', 'dpt'].includes(source)) {
    return libreOfficeConversion(bytes, sourceName, target, signal)
  }
  if (['md', 'html', 'epub'].includes(source) && ['docx', 'pdf', 'epub'].includes(target)) {
    return pandocConversion(bytes, sourceName, target, signal)
  }
  throw new ExternalConversionError('当前格式组合没有可用的外部转换路径')
}
