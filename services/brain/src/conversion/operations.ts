import { PDFDocument, PageSizes } from 'pdf-lib'
import type { ConversionFormat } from '@pi-amadeus/shared'
import { CONVERSION_LIMITS } from '@pi-amadeus/shared'
import { externalConversion, ExternalConversionError } from './external.ts'

export class ConversionFailure extends Error {
  readonly code: 'invalid-input' | 'resource-limit' | 'unsupported-format' | 'conversion-failed'

  constructor(
    message: string,
    code: 'invalid-input' | 'resource-limit' | 'unsupported-format' | 'conversion-failed'
  ) {
    super(message)
    this.name = 'ConversionFailure'
    this.code = code
  }
}

export interface ConversionOutput {
  bytes: Uint8Array
  format: ConversionFormat
  mimeType: string
}

const IMAGE_FORMATS = new Set<ConversionFormat>(['png', 'jpg', 'webp', 'avif', 'tiff', 'gif'])
const OFFICEPARSER_INPUTS = new Set<ConversionFormat>([
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'pdf',
  'rtf',
  'md',
  'html',
  'csv',
  'epub'
])
const OFFICEPARSER_OUTPUTS = new Set<ConversionFormat>(['txt', 'md', 'html', 'pdf', 'csv', 'rtf', 'epub'])

function normalizeFormat(value: string): ConversionFormat {
  const format = value.trim().toLowerCase().replace(/^\./, '')
  if (format === 'jpeg') return 'jpg'
  if (format === 'markdown') return 'md'
  if (format === 'yml') return 'yaml'
  return format as ConversionFormat
}

function extensionOf(name: string): ConversionFormat {
  const extension = name.split(/[\\/]/).pop()?.split('.').pop() ?? ''
  return normalizeFormat(extension)
}

function mimeTypeOf(format: ConversionFormat): string {
  switch (format) {
    case 'jpg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'avif':
      return 'image/avif'
    case 'tiff':
      return 'image/tiff'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'pdf':
      return 'application/pdf'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'html':
      return 'text/html; charset=utf-8'
    case 'md':
      return 'text/markdown; charset=utf-8'
    case 'csv':
      return 'text/csv; charset=utf-8'
    case 'txt':
    default:
      return 'text/plain; charset=utf-8'
  }
}

function checkInputSize(bytes: Uint8Array): void {
  if (bytes.byteLength > CONVERSION_LIMITS.maxSingleFileBytes) {
    throw new ConversionFailure('单个文件超过大小限制', 'resource-limit')
  }
  if (bytes.byteLength === 0) throw new ConversionFailure('文件内容为空', 'invalid-input')
}

function ensureOutputSize(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > CONVERSION_LIMITS.maxOutputBytes) {
    throw new ConversionFailure('转换结果超过大小限制', 'resource-limit')
  }
  return bytes
}

async function sharpOf(): Promise<typeof import('sharp').default> {
  try {
    const module = await import('sharp')
    return module.default
  } catch (error) {
    throw new ConversionFailure(
      `图像引擎不可用：${error instanceof Error ? error.message : String(error)}`,
      'conversion-failed'
    )
  }
}

export function outputName(name: string, format: ConversionFormat): string {
  const base = name.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, '') || 'converted'
  const extension = format === 'jpg' ? 'jpg' : format
  return `${base}.${extension}`
}

export async function convertImage(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  quality?: number
): Promise<ConversionOutput> {
  checkInputSize(bytes)
  const source = extensionOf(sourceName)
  if (!IMAGE_FORMATS.has(source) || !IMAGE_FORMATS.has(target)) {
    throw new ConversionFailure('仅支持常见图片格式之间的转换', 'unsupported-format')
  }
  const sharp = await sharpOf()
  let pipeline = sharp(Buffer.from(bytes), { limitInputPixels: 50_000_000 }).rotate()
  const boundedQuality = Math.max(1, Math.min(100, Math.round(quality ?? 90)))
  switch (target) {
    case 'jpg':
      pipeline = pipeline.jpeg({ quality: boundedQuality, mozjpeg: false })
      break
    case 'png':
      pipeline = pipeline.png()
      break
    case 'webp':
      pipeline = pipeline.webp({ quality: boundedQuality })
      break
    case 'avif':
      pipeline = pipeline.avif({ quality: boundedQuality })
      break
    case 'tiff':
      pipeline = pipeline.tiff({ quality: boundedQuality })
      break
    case 'gif':
      pipeline = pipeline.gif()
      break
    default:
      throw new ConversionFailure(`暂不支持输出 ${target}`, 'unsupported-format')
  }
  const output = await pipeline.toBuffer()
  return { bytes: ensureOutputSize(new Uint8Array(output)), format: target, mimeType: mimeTypeOf(target) }
}

async function embedImage(pdf: PDFDocument, bytes: Uint8Array, name: string): Promise<{ image: Awaited<ReturnType<PDFDocument['embedPng']>>; width: number; height: number }> {
  const format = extensionOf(name)
  if (format === 'jpg') {
    const image = await pdf.embedJpg(bytes)
    return { image, width: image.width, height: image.height }
  }
  if (format === 'png') {
    const image = await pdf.embedPng(bytes)
    return { image, width: image.width, height: image.height }
  }
  const sharp = await sharpOf()
  const normalized = await sharp(Buffer.from(bytes)).png().toBuffer()
  const image = await pdf.embedPng(normalized)
  return { image, width: image.width, height: image.height }
}

export async function imagesToPdf(files: Array<{ bytes: Uint8Array; name: string }>): Promise<ConversionOutput> {
  if (files.length === 0) throw new ConversionFailure('至少需要一张图片', 'invalid-input')
  if (files.length > CONVERSION_LIMITS.maxFiles) throw new ConversionFailure('图片数量超过限制', 'resource-limit')
  const pdf = await PDFDocument.create()
  for (const file of files) {
    checkInputSize(file.bytes)
    const { image, width, height } = await embedImage(pdf, file.bytes, file.name)
    const landscape = width > height
    const pageWidth = landscape ? PageSizes.A4[1] : PageSizes.A4[0]
    const pageHeight = landscape ? PageSizes.A4[0] : PageSizes.A4[1]
    const margin = 18
    const scale = Math.min((pageWidth - margin * 2) / width, (pageHeight - margin * 2) / height)
    const drawWidth = width * scale
    const drawHeight = height * scale
    const page = pdf.addPage([pageWidth, pageHeight])
    page.drawImage(image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight
    })
  }
  const bytes = await pdf.save()
  return { bytes: ensureOutputSize(bytes), format: 'pdf', mimeType: mimeTypeOf('pdf') }
}

export async function mergePdfs(files: Uint8Array[]): Promise<ConversionOutput> {
  if (files.length < 2) throw new ConversionFailure('合并 PDF 至少需要两个文件', 'invalid-input')
  if (files.length > CONVERSION_LIMITS.maxFiles) throw new ConversionFailure('PDF 数量超过限制', 'resource-limit')
  const merged = await PDFDocument.create()
  for (const bytes of files) {
    checkInputSize(bytes)
    const source = await PDFDocument.load(bytes, { throwOnInvalidObject: false })
    if (merged.getPageCount() + source.getPageCount() > CONVERSION_LIMITS.maxPdfPages) {
      throw new ConversionFailure('PDF 页数超过限制', 'resource-limit')
    }
    const pages = await merged.copyPages(source, source.getPageIndices())
    pages.forEach((page) => merged.addPage(page))
  }
  const output = await merged.save()
  return { bytes: ensureOutputSize(output), format: 'pdf', mimeType: mimeTypeOf('pdf') }
}

export async function convertOfficeDocument(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<ConversionOutput> {
  checkInputSize(bytes)
  const source = extensionOf(sourceName)
  if (!OFFICEPARSER_INPUTS.has(source) || !OFFICEPARSER_OUTPUTS.has(target)) {
    throw new ConversionFailure('该文件格式或目标格式未纳入文档转换引擎', 'unsupported-format')
  }
  if (signal?.aborted) throw new ConversionFailure('转换已取消', 'conversion-failed')
  try {
    const { OfficeConverter } = await import('officeparser')
    const destination = target === 'txt' ? 'text' : target
    const result = await OfficeConverter.convert(Buffer.from(bytes), destination as 'text' | 'md' | 'html' | 'pdf' | 'csv' | 'rtf' | 'epub', {
      parseConfig: { fileType: source as 'docx' | 'pptx' | 'xlsx' | 'odt' | 'odp' | 'ods' | 'pdf' | 'rtf' | 'md' | 'html' | 'csv' | 'epub' },
      generatorConfig: target === 'pdf' ? { pdfConfig: { engine: 'native' } } : undefined
    })
    if (signal?.aborted) throw new ConversionFailure('转换已取消', 'conversion-failed')
    const value = typeof result.value === 'string' ? new TextEncoder().encode(result.value) : new Uint8Array(result.value)
    return { bytes: ensureOutputSize(value), format: target, mimeType: mimeTypeOf(target) }
  } catch (error) {
    if (error instanceof ConversionFailure) throw error
    throw new ConversionFailure(error instanceof Error ? error.message : String(error), 'conversion-failed')
  }
}

export async function convertFile(
  bytes: Uint8Array,
  sourceName: string,
  targetValue: string,
  quality?: number,
  signal?: AbortSignal
): Promise<ConversionOutput> {
  const target = normalizeFormat(targetValue)
  const source = extensionOf(sourceName)
  if (IMAGE_FORMATS.has(source) && IMAGE_FORMATS.has(target)) {
    return convertImage(bytes, sourceName, target, quality)
  }
  try {
    return await convertOfficeDocument(bytes, sourceName, target, signal)
  } catch (error) {
    if (!(error instanceof ConversionFailure) || error.code !== 'unsupported-format') throw error
    const knownSource = new Set<ConversionFormat>([
      'doc', 'docx', 'odt', 'rtf', 'wps', 'wpt', 'wpd', 'ofd', 'xls', 'xlsx', 'xlsm', 'ods', 'et', 'ett',
      'ppt', 'pptx', 'odp', 'dps', 'dpt', 'pdf', 'md', 'html', 'csv', 'epub',
      'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv'
    ])
    if (!knownSource.has(source)) throw new ConversionFailure('输入格式不受支持', 'unsupported-format')
    try {
      const output = await externalConversion(bytes, sourceName, source, target, signal)
      return { bytes: ensureOutputSize(output), format: target, mimeType: mimeTypeOf(target) }
    } catch (externalError) {
      if (externalError instanceof ExternalConversionError) {
        throw new ConversionFailure(externalError.message, 'conversion-failed')
      }
      throw externalError
    }
  }
}
