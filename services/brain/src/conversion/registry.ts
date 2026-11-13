import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import type {
  ConversionCapabilities,
  ConversionEngineCapability,
  ConversionFormat,
  ConversionOperationCapability,
  ConversionReasonCode
} from '@pi-amadeus/shared'
import { CONVERSION_FORMATS, CONVERSION_LIMITS } from '@pi-amadeus/shared'

const PROBE_TIMEOUT_MS = 2_000
const PROBED_EXECUTABLES = [
  { id: 'ffmpeg', label: 'FFmpeg', command: 'ffmpeg', args: ['-version'] },
  { id: 'ffprobe', label: 'FFprobe', command: 'ffprobe', args: ['-version'] },
  { id: 'pdftoppm', label: 'Poppler pdftoppm', command: 'pdftoppm', args: ['-v'] },
  { id: 'pdfinfo', label: 'Poppler pdfinfo', command: 'pdfinfo', args: ['-v'] },
  { id: 'soffice', label: 'LibreOffice', command: 'soffice', args: ['--version'] },
  { id: 'libreoffice', label: 'LibreOffice', command: 'libreoffice', args: ['--version'] },
  { id: 'tesseract', label: 'Tesseract OCR', command: 'tesseract', args: ['--version'] },
  { id: 'pandoc', label: 'Pandoc', command: 'pandoc', args: ['--version'] }
] as const

const OFFICE_FORMATS = CONVERSION_FORMATS.office
const IMAGE_FORMATS = CONVERSION_FORMATS.image
const AUDIO_FORMATS = CONVERSION_FORMATS.audio
const VIDEO_FORMATS = CONVERSION_FORMATS.video
const DOCUMENT_FORMATS = CONVERSION_FORMATS.document
const TEXT_FORMATS = CONVERSION_FORMATS.text

let cached: ConversionCapabilities | null = null

function packageCapability(
  id: string,
  label: string,
  status: ConversionEngineCapability['status'],
  reason?: ConversionReasonCode,
  detail?: string
): ConversionEngineCapability {
  return { id, label, kind: 'package', status, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) }
}

function executableCapability(
  id: string,
  label: string,
  status: ConversionEngineCapability['status'],
  version?: string,
  reason?: ConversionReasonCode,
  detail?: string
): ConversionEngineCapability {
  return {
    id,
    label,
    kind: 'executable',
    status,
    ...(version ? { version } : {}),
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {})
  }
}

async function probeExecutable(input: (typeof PROBED_EXECUTABLES)[number]): Promise<ConversionEngineCapability> {
  try {
    await access(input.command, constants.X_OK)
  } catch {
    // `access` cannot resolve PATH entries on every platform; spawn remains the authority.
  }
  return await new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8').slice(0, 400)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill()
      resolve(executableCapability(input.id, input.label, 'broken', undefined, 'version-probe-failed', '探测超时'))
    }, PROBE_TIMEOUT_MS)
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const missing = error.code === 'ENOENT'
      resolve(
        executableCapability(
          input.id,
          input.label,
          missing ? 'missing' : 'broken',
          undefined,
          missing ? 'binary-not-found' : 'version-probe-failed',
          missing ? undefined : error.message.slice(0, 200)
        )
      )
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        const version = output.split(/\r?\n/, 1)[0]?.trim().slice(0, 120)
        resolve(executableCapability(input.id, input.label, 'detected', version))
      } else {
        resolve(executableCapability(input.id, input.label, 'broken', undefined, 'version-probe-failed', output.trim().slice(0, 200)))
      }
    })
  })
}

function operation(
  id: ConversionOperationCapability['id'],
  label: string,
  inputs: ConversionFormat[],
  outputs: ConversionFormat[],
  status: ConversionOperationCapability['status'],
  engines: string[],
  reason?: ConversionReasonCode
): ConversionOperationCapability {
  return { id, label, inputs, outputs, status, engines, ...(reason ? { reason } : {}) }
}

function operationsOf(engines: ConversionEngineCapability[]): ConversionOperationCapability[] {
  const sharp = engines.find((engine) => engine.id === 'sharp')
  const pdfLib = engines.find((engine) => engine.id === 'pdf-lib')
  const office = engines.find((engine) => engine.id === 'officeparser')
  const ffmpeg = engines.find((engine) => engine.id === 'ffmpeg')
  const poppler = engines.find((engine) => engine.id === 'pdftoppm')
  const tesseract = engines.find((engine) => engine.id === 'tesseract')
  const officeReady = office?.status === 'ready'
  const detectedOffice = engines.some((engine) => ['soffice', 'libreoffice', 'pandoc'].includes(engine.id) && engine.status === 'detected')
  const imageReady = sharp?.status === 'ready'
  const pdfReady = pdfLib?.status === 'ready'
  return [
    operation('convert', '通用文档与媒体转换', [...IMAGE_FORMATS, ...TEXT_FORMATS, ...OFFICE_FORMATS, ...DOCUMENT_FORMATS, ...AUDIO_FORMATS, ...VIDEO_FORMATS], [...TEXT_FORMATS, ...DOCUMENT_FORMATS, ...OFFICE_FORMATS, ...IMAGE_FORMATS, ...AUDIO_FORMATS, ...VIDEO_FORMATS], officeReady ? 'ready' : detectedOffice ? 'detected' : 'unsupported', ['officeparser', 'soffice', 'pandoc', 'ffmpeg'], officeReady || detectedOffice ? undefined : 'operation-not-enabled'),
    operation('images-to-pdf', '图片合并为 PDF', IMAGE_FORMATS, ['pdf'], imageReady && pdfReady ? 'ready' : 'unsupported', ['sharp', 'pdf-lib'], imageReady && pdfReady ? undefined : 'package-load-failed'),
    operation('merge-pdfs', '合并 PDF', ['pdf'], ['pdf'], pdfReady ? 'ready' : 'unsupported', ['pdf-lib'], pdfReady ? undefined : 'package-load-failed'),
    operation('pdf-raster', 'PDF 渲染为图片', ['pdf'], IMAGE_FORMATS, poppler?.status === 'detected' ? 'detected' : 'unsupported', ['pdftoppm'], poppler?.status === 'detected' ? undefined : 'binary-not-found'),
    operation('media-convert', '音视频转换', [...AUDIO_FORMATS, ...VIDEO_FORMATS], [...AUDIO_FORMATS, ...VIDEO_FORMATS], ffmpeg?.status === 'detected' ? 'detected' : 'unsupported', ['ffmpeg', 'ffprobe'], ffmpeg?.status === 'detected' ? 'operation-not-enabled' : 'binary-not-found'),
    operation('ocr', 'OCR 文字识别', [...IMAGE_FORMATS, 'pdf'], ['txt', 'md'], tesseract?.status === 'detected' ? 'detected' : 'unsupported', ['tesseract'], tesseract?.status === 'detected' ? 'operation-not-enabled' : 'binary-not-found')
  ]
}

export async function getConversionCapabilities(force = false): Promise<ConversionCapabilities> {
  if (cached && !force) return cached
  const packages = await Promise.all([
    import('sharp')
      .then(() => packageCapability('sharp', 'Sharp 图像引擎', 'ready'))
      .catch((error: unknown) => packageCapability('sharp', 'Sharp 图像引擎', 'broken', 'package-load-failed', error instanceof Error ? error.message.slice(0, 200) : String(error))),
    import('pdf-lib')
      .then(() => packageCapability('pdf-lib', 'PDF-Lib PDF 引擎', 'ready'))
      .catch((error: unknown) => packageCapability('pdf-lib', 'PDF-Lib PDF 引擎', 'broken', 'package-load-failed', error instanceof Error ? error.message.slice(0, 200) : String(error))),
    import('officeparser')
      .then(() => packageCapability('officeparser', 'OfficeParser 文档引擎', 'ready'))
      .catch((error: unknown) => packageCapability('officeparser', 'OfficeParser 文档引擎', 'broken', 'package-load-failed', error instanceof Error ? error.message.slice(0, 200) : String(error)))
  ])
  const executables = await Promise.all(PROBED_EXECUTABLES.map(probeExecutable))
  cached = {
    schemaVersion: 1,
    checkedAt: Date.now(),
    engines: [...packages, ...executables],
    operations: operationsOf([...packages, ...executables]),
    limits: CONVERSION_LIMITS
  }
  return cached
}

export function clearConversionCapabilities(): void {
  cached = null
}
