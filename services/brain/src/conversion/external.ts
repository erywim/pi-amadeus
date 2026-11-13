import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { ConversionFormat } from '@pi-amadeus/shared'

const COMMAND_TIMEOUT_MS = 120_000
const MAX_EXTERNAL_OUTPUT_BYTES = 512 * 1024 * 1024
const MAX_DIAGNOSTIC_CHARS = 4_000
const MEDIA_FORMATS = new Set<ConversionFormat>([
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma',
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv'
])
const OFFICE_FORMATS = new Set<ConversionFormat>([
  'doc', 'docx', 'odt', 'rtf', 'wps', 'wpt', 'wpd', 'ofd',
  'xls', 'xlsx', 'xlsm', 'ods', 'et', 'ett', 'ppt', 'pptx', 'odp', 'dps', 'dpt'
])
const OFFICE_EXECUTABLES = process.platform === 'win32' ? ['soffice.exe', 'libreoffice.exe'] : ['soffice', 'libreoffice']

async function commandExists(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, ['--version'], { shell: false, env: childEnvironment(), stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

async function officeCommand(): Promise<string> {
  for (const command of OFFICE_EXECUTABLES) {
    if (await commandExists(command)) return command
  }
  throw new ExternalConversionError('未找到 LibreOffice 转换引擎')
}

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

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
}

function commandResult(command: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
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
    const stop = (): void => {
      if (!child.killed) child.kill()
    }
    const onAbort = (): void => {
      stop()
      finish(() => reject(new ExternalConversionError('转换已取消')))
    }
    const timer = setTimeout(() => {
      stop()
      finish(() => reject(new ExternalConversionError('外部转换引擎超时')))
    }, COMMAND_TIMEOUT_MS)
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const current = target === 'stdout' ? stdout : stderr
      const next = `${current}${chunk.toString('utf8')}`.slice(0, MAX_DIAGNOSTIC_CHARS)
      if (target === 'stdout') stdout = next
      else stderr = next
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new ExternalConversionError(error.code === 'ENOENT' ? '未找到外部转换引擎' : error.message)))
    })
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolveResult({ stdout, stderr })
        else reject(new ExternalConversionError(stderr.trim() || `${command} 退出码 ${String(code)}`))
      })
    })
  })
}

async function readOutput(path: string): Promise<Uint8Array> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new ExternalConversionError('外部转换结果不是文件')
  if (metadata.size > MAX_EXTERNAL_OUTPUT_BYTES) throw new ExternalConversionError('外部转换结果超过限制')
  return new Uint8Array(await readFile(path))
}

async function outputFileOf(dir: string, expectedExtension?: string): Promise<string> {
  const entries = (await readdir(dir)).filter((entry) => !entry.startsWith('.'))
  const candidates = expectedExtension ? entries.filter((entry) => entry.toLowerCase().endsWith(expectedExtension)) : entries
  const name = (candidates.length > 0 ? candidates : entries)[0]
  if (!name) throw new ExternalConversionError('外部转换引擎未生成结果')
  const output = resolve(dir, name)
  const root = `${resolve(dir)}${process.platform === 'win32' ? '\\' : '/'}`
  if (!output.startsWith(root)) throw new ExternalConversionError('外部转换结果路径非法')
  return output
}

async function ffmpegConversion(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!MEDIA_FORMATS.has(target)) throw new ExternalConversionError('音视频目标格式不受支持')
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-convert-'))
  try {
    const input = join(dir, `input${safeExtension(sourceName)}`)
    const outputExtension = target
    const output = join(dir, `output.${outputExtension}`)
    await writeFile(input, bytes)
    await commandResult('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'file,crypto,data',
      '-i', input,
      '-fs', String(MAX_EXTERNAL_OUTPUT_BYTES),
      output
    ], signal)
    return await readOutput(output)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function pdfRaster(
  bytes: Uint8Array,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!['png', 'jpg', 'tiff'].includes(target)) throw new ExternalConversionError('PDF 图片目标格式不受支持')
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-pdf-'))
  try {
    const input = join(dir, 'input.pdf')
    const prefix = join(dir, 'page')
    const formatArgs: string[] = target === 'jpg' ? ['-jpeg'] : target === 'tiff' ? ['-tiff'] : ['-png']
    await writeFile(input, bytes)
    await commandResult('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-r', '150', ...formatArgs, input, prefix], signal)
    const output = await outputFileOf(dir, target === 'jpg' ? '.jpg' : `.${target}`)
    return await readOutput(output)
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
  if (!OFFICE_FORMATS.has(target) && !['pdf', 'txt', 'html', 'csv', 'epub'].includes(target)) {
    throw new ExternalConversionError('办公文档目标格式不受支持')
  }
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-office-'))
  const profile = join(dir, 'profile')
  try {
    const input = join(dir, `input${safeExtension(sourceName)}`)
    await writeFile(input, bytes)
    const profileUrl = pathToFileURL(profile).toString()
    const command = await officeCommand()
    await commandResult(
      command,
      ['--headless', `-env:UserInstallation=${profileUrl}`, '--convert-to', target, '--outdir', dir, input],
      signal
    )
    const output = await outputFileOf(dir, `.${target}`)
    return await readOutput(output)
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
  if (!['docx', 'pdf', 'epub', 'odt', 'rtf', 'html', 'txt', 'md'].includes(target)) {
    throw new ExternalConversionError('Pandoc 目标格式不受支持')
  }
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-pandoc-'))
  try {
    const input = join(dir, `input${safeExtension(sourceName)}`)
    const output = join(dir, `output.${target}`)
    await writeFile(input, bytes)
    await commandResult('pandoc', [input, '-o', output], signal)
    return await readOutput(output)
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
  if (MEDIA_FORMATS.has(source)) return ffmpegConversion(bytes, sourceName, target, signal)
  if (['png', 'jpg', 'webp', 'tiff', 'gif', 'avif', 'bmp'].includes(source) && ['txt', 'md'].includes(target)) {
    return tesseractOcr(bytes, sourceName, signal)
  }
  if (OFFICE_FORMATS.has(source)) return libreOfficeConversion(bytes, sourceName, target, signal)
  if (['md', 'html', 'epub', 'tex'].includes(source)) return pandocConversion(bytes, sourceName, target, signal)
  throw new ExternalConversionError('当前格式组合没有可用的外部转换路径')
}
