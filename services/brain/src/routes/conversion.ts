import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Hono } from 'hono'
import type {
  ConversionErrorResponse,
  ConversionFormat,
  ConversionTargetsResponse
} from '@pi-amadeus/shared'
import { CONVERSION_LIMITS } from '@pi-amadeus/shared'
import { ConversionFailure, convertFile, imagesToPdf, mergePdfs, outputName } from '../conversion/operations.ts'
import { clearConversionCapabilities, getConversionCapabilities } from '../conversion/registry.ts'

const IMAGE_INPUTS = new Set<ConversionFormat>(['png', 'jpg', 'webp', 'avif', 'tiff', 'gif'])
const OFFICE_INPUTS = new Set<ConversionFormat>([
  'doc', 'docx', 'odt', 'rtf', 'wps', 'wpt', 'wpd', 'ofd',
  'xls', 'xlsx', 'xlsm', 'ods', 'et', 'ett',
  'ppt', 'pptx', 'odp', 'dps', 'dpt', 'pdf', 'md', 'html', 'csv', 'epub'
])
const MEDIA_INPUTS = new Set<ConversionFormat>([
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma',
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv'
])
const IMAGE_OUTPUTS = ['png', 'jpg', 'webp', 'avif', 'tiff', 'gif'] as ConversionFormat[]
const OFFICE_OUTPUTS = ['txt', 'md', 'html', 'pdf', 'csv', 'rtf', 'epub'] as ConversionFormat[]
const OFFICE_EXTERNAL_OUTPUTS = [
  'docx', 'odt', 'rtf', 'pdf', 'txt', 'html', 'md',
  'xlsx', 'xls', 'ods', 'csv', 'pptx', 'odp'
] as ConversionFormat[]
const MEDIA_OUTPUTS = [
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma',
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'gif-video'
] as ConversionFormat[]

interface UploadedFile {
  bytes: Uint8Array
  name: string
}

function errorResponse(error: unknown): { body: ConversionErrorResponse; status: ContentfulStatusCode } {
  if (error instanceof ConversionFailure) {
    const status: ContentfulStatusCode =
      error.code === 'resource-limit' ? 413 : error.code === 'unsupported-format' ? 415 : error.code === 'invalid-input' ? 422 : 422
    return { body: { error: error.message, code: error.code }, status }
  }
  return {
    body: { error: error instanceof Error ? error.message : String(error), code: 'conversion-failed' },
    status: 500
  }
}

function extensionOf(name: string): ConversionFormat {
  const extension = name.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
  return (extension === 'jpeg' ? 'jpg' : extension) as ConversionFormat
}

function contentDisposition(name: string): string {
  const safe = name.replace(/[\r\n"\\]/g, '_').slice(0, 180) || 'converted.bin'
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

async function parseFiles(c: Context, field: string): Promise<UploadedFile[]> {
  const form = await c.req.parseBody({ all: true })
  const values = form[field]
  const files = (Array.isArray(values) ? values : [values]).filter((value): value is File => value instanceof File)
  if (files.length === 0) throw new ConversionFailure(`缺少文件字段：${field}`, 'invalid-input')
  if (files.length > CONVERSION_LIMITS.maxFiles) throw new ConversionFailure('文件数量超过限制', 'resource-limit')
  let total = 0
  const result: UploadedFile[] = []
  for (const file of files) {
    total += file.size
    if (file.size > CONVERSION_LIMITS.maxSingleFileBytes) throw new ConversionFailure('单个文件超过大小限制', 'resource-limit')
    if (total > CONVERSION_LIMITS.maxRequestBytes) throw new ConversionFailure('请求总大小超过限制', 'resource-limit')
    result.push({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || 'input.bin' })
  }
  return result
}

function binaryResponse(output: { bytes: Uint8Array; mimeType: string }, name: string): Response {
  return new Response(output.bytes, {
    status: 200,
    headers: {
      'Content-Type': output.mimeType,
      'Content-Length': String(output.bytes.byteLength),
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store'
    }
  })
}

export function conversionRoutes(): Hono {
  const app = new Hono()

  app.get('/conversion/capabilities', async (c) => c.json(await getConversionCapabilities()))
  app.post('/conversion/capabilities/refresh', async (c) => {
    clearConversionCapabilities()
    return c.json(await getConversionCapabilities(true))
  })

  app.post('/conversion/targets', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { extension?: unknown } | null
    const extension = typeof body?.extension === 'string' ? extensionOf(body.extension) : ''
    if (!extension) return c.json({ error: 'extension 必填', code: 'invalid-input' } satisfies ConversionErrorResponse, 400)
    const capabilities = await getConversionCapabilities()
    const operation = capabilities.operations.find((item) => item.id === 'convert')
    const isImage = IMAGE_INPUTS.has(extension)
    const isOffice = OFFICE_INPUTS.has(extension)
    const isMedia = MEDIA_INPUTS.has(extension)
    const targets: ConversionFormat[] = isImage
      ? IMAGE_OUTPUTS
      : isMedia
        ? MEDIA_OUTPUTS
        : isOffice
          ? operation?.status === 'ready'
            ? OFFICE_OUTPUTS
            : operation?.status === 'detected'
              ? OFFICE_EXTERNAL_OUTPUTS
              : []
          : []
    const response: ConversionTargetsResponse = {
      extension,
      category: isImage ? 'image' : isMedia ? 'media' : isOffice ? 'document' : 'unknown',
      targets,
      experimental: []
    }
    return c.json(response)
  })

  app.post('/conversion/convert', async (c) => {
    try {
      const files = await parseFiles(c, 'file')
      if (files.length !== 1) throw new ConversionFailure('单文件转换只接受一个文件', 'invalid-input')
      const form = await c.req.parseBody()
      const target = typeof form.to === 'string' ? form.to : typeof form.targetFormat === 'string' ? form.targetFormat : ''
      if (!target) throw new ConversionFailure('缺少目标格式', 'invalid-input')
      const quality = typeof form.quality === 'string' ? Number(form.quality) : undefined
      const output = await convertFile(files[0]!.bytes, files[0]!.name, target, quality, c.req.raw.signal)
      return binaryResponse(output, outputName(files[0]!.name, output.format))
    } catch (error) {
      const mapped = errorResponse(error)
      return c.json(mapped.body, mapped.status)
    }
  })

  app.post('/conversion/images-to-pdf', async (c) => {
    try {
      const files = await parseFiles(c, 'files')
      const output = await imagesToPdf(files)
      return binaryResponse(output, 'images.pdf')
    } catch (error) {
      const mapped = errorResponse(error)
      return c.json(mapped.body, mapped.status)
    }
  })

  app.post('/conversion/merge-pdfs', async (c) => {
    try {
      const files = await parseFiles(c, 'files')
      const output = await mergePdfs(files.map((file) => file.bytes))
      return binaryResponse(output, 'merged.pdf')
    } catch (error) {
      const mapped = errorResponse(error)
      return c.json(mapped.body, mapped.status)
    }
  })

  return app
}
