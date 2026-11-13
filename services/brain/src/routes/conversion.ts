import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Hono } from 'hono'
import type {
  ConversionErrorResponse,
  ConversionFormat,
  ConversionOperationId,
  ConversionTargetsResponse
} from '@pi-amadeus/shared'
import {
  CONVERSION_FORMATS,
  CONVERSION_LIMITS,
  conversionExtension,
  normalizeConversionFormat
} from '@pi-amadeus/shared'
import {
  ConversionFailure,
  convertFile,
  imagesToPdf,
  imagesToZip,
  mergePdfs,
  outputName
} from '../conversion/operations.ts'
import { clearConversionCapabilities, getConversionCapabilities } from '../conversion/registry.ts'

const IMAGE_INPUTS = new Set<ConversionFormat>(CONVERSION_FORMATS.image)
const TEXT_INPUTS = new Set<ConversionFormat>(CONVERSION_FORMATS.text)
const OFFICE_INPUTS = new Set<ConversionFormat>([
  ...CONVERSION_FORMATS.office,
  ...CONVERSION_FORMATS.document
])
const MEDIA_INPUTS = new Set<ConversionFormat>([
  ...CONVERSION_FORMATS.audio,
  ...CONVERSION_FORMATS.video
])
const IMAGE_OUTPUTS = ['png', 'jpg', 'webp', 'avif', 'tiff', 'gif'] as ConversionFormat[]
const TEXT_OUTPUTS = ['txt', 'md', 'html', 'json', 'csv', 'tsv', 'yaml', 'xml', 'log'] as ConversionFormat[]
const OFFICE_OUTPUTS = [
  'txt', 'md', 'html', 'pdf', 'csv', 'rtf', 'epub', 'docx', 'odt', 'xlsx', 'ods', 'pptx', 'odp', 'tex'
] as ConversionFormat[]
const MEDIA_OUTPUTS = [
  ...CONVERSION_FORMATS.audio,
  ...CONVERSION_FORMATS.video
]

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
  // 引擎错误不把本地路径、命令行或环境细节回传给桌面端，避免泄露服务端信息。
  return { body: { error: '转换失败，请检查输入文件或当前可用引擎', code: 'conversion-failed' }, status: 500 }
}

function contentDisposition(name: string): string {
  const safe = [...name]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f && code !== 0x2028 && code !== 0x2029 && char !== '"' && char !== '\\'
    })
    .join('')
    .slice(0, 180) || 'converted.bin'
  const asciiFallback = safe.replace(/[^\x20-\x7e]/g, '_') || 'converted.bin'
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`
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

function targetsFor(extension: ConversionFormat, capabilities: Awaited<ReturnType<typeof getConversionCapabilities>>): {
  category: string
  operation: ConversionOperationId
  targets: ConversionFormat[]
} {
  const engine = (id: string): boolean => {
    const item = capabilities.engines.find((candidate) => candidate.id === id)
    return item?.status === 'ready' || item?.status === 'detected'
  }
  if (IMAGE_INPUTS.has(extension)) {
    const targets = engine('sharp') ? IMAGE_OUTPUTS : []
    return { category: 'image', operation: 'convert', targets }
  }
  if (TEXT_INPUTS.has(extension)) {
    const targets = engine('officeparser') || engine('pandoc') ? TEXT_OUTPUTS : []
    return { category: 'text', operation: 'convert', targets }
  }
  if (MEDIA_INPUTS.has(extension)) {
    return { category: 'media', operation: 'media-convert', targets: engine('ffmpeg') ? MEDIA_OUTPUTS : [] }
  }
  if (extension === 'pdf') {
    const targets = [
      ...(engine('officeparser') ? OFFICE_OUTPUTS : []),
      ...(engine('pdftoppm') ? ['png', 'jpg', 'tiff' as ConversionFormat] : [])
    ]
    return { category: 'document', operation: 'convert', targets: [...new Set(targets)] as ConversionFormat[] }
  }
  if (OFFICE_INPUTS.has(extension)) {
    const targets = [
      ...(engine('officeparser') ? OFFICE_OUTPUTS : []),
      ...(engine('soffice') || engine('libreoffice') ? OFFICE_OUTPUTS : [])
    ]
    return { category: 'document', operation: 'office-convert', targets: [...new Set(targets)] as ConversionFormat[] }
  }
  return { category: 'unknown', operation: 'convert', targets: [] }
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
    const extension = typeof body?.extension === 'string' ? conversionExtension(body.extension) : ''
    if (!extension) return c.json({ error: 'extension 必填', code: 'invalid-input' } satisfies ConversionErrorResponse, 400)
    const capabilities = await getConversionCapabilities()
    const selected = targetsFor(extension, capabilities)
    const response: ConversionTargetsResponse = {
      extension,
      category: selected.category,
      operation: selected.operation,
      targets: selected.targets,
      experimental: []
    }
    return c.json(response)
  })

  app.post('/conversion/convert', async (c) => {
    try {
      const files = await parseFiles(c, 'file')
      if (files.length !== 1) throw new ConversionFailure('单文件转换只接受一个文件', 'invalid-input')
      const form = await c.req.parseBody()
      const rawTarget = typeof form.to === 'string' ? form.to : typeof form.targetFormat === 'string' ? form.targetFormat : ''
      const target = normalizeConversionFormat(rawTarget)
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

  app.post('/conversion/images-to-zip', async (c) => {
    try {
      const files = await parseFiles(c, 'files')
      const output = await imagesToZip(files)
      return binaryResponse(output, 'images.zip')
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
