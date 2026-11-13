import { PDFDocument, PageSizes } from 'pdf-lib'
import type { PDFImage } from 'pdf-lib'
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml'
import type { ConversionFormat } from '@pi-amadeus/shared'
import {
  CONVERSION_FORMATS,
  CONVERSION_LIMITS,
  conversionExtension,
  normalizeConversionFormat
} from '@pi-amadeus/shared'
import { zipSync } from 'fflate'
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

const IMAGE_FORMATS = new Set<ConversionFormat>(CONVERSION_FORMATS.image)
const OFFICEPARSER_INPUTS = new Set<ConversionFormat>([
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'odg',
  'pdf',
  'rtf',
  'md',
  'html',
  'csv',
  'epub',
  'tex'
])
const OFFICEPARSER_OUTPUTS = new Set<ConversionFormat>([
  'txt',
  'md',
  'html',
  'pdf',
  'csv',
  'rtf',
  'epub',
  'docx',
  'odt',
  'xlsx',
  'ods',
  'pptx',
  'odp',
  'tex'
])
const TEXT_FORMATS = new Set<ConversionFormat>(CONVERSION_FORMATS.text)
const KNOWN_INPUTS = new Set<ConversionFormat>([
  ...CONVERSION_FORMATS.image,
  ...CONVERSION_FORMATS.text,
  ...CONVERSION_FORMATS.office,
  ...CONVERSION_FORMATS.document,
  ...CONVERSION_FORMATS.archive,
  ...CONVERSION_FORMATS.audio,
  ...CONVERSION_FORMATS.video
])

const MIME_TYPES: Partial<Record<ConversionFormat, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  zip: 'application/zip',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  tex: 'application/x-tex; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wma: 'audio/x-ms-wma',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv'
}

function mimeTypeOf(format: ConversionFormat): string {
  return MIME_TYPES[format] ?? 'application/octet-stream'
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

function textOf(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
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
  return `${base}.${format}`
}

export async function convertImage(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  quality?: number
): Promise<ConversionOutput> {
  checkInputSize(bytes)
  const source = conversionExtension(sourceName)
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

async function embedImage(pdf: PDFDocument, bytes: Uint8Array, name: string): Promise<{ image: PDFImage; width: number; height: number }> {
  const format = conversionExtension(name)
  if (format === 'jpg') {
    const image = await pdf.embedJpg(bytes)
    return { image, width: image.width, height: image.height }
  }
  if (format === 'png') {
    const image = await pdf.embedPng(bytes)
    return { image, width: image.width, height: image.height }
  }
  const sharp = await sharpOf()
  const normalized = await sharp(Buffer.from(bytes), { limitInputPixels: 50_000_000 }).png().toBuffer()
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

export async function imagesToZip(files: Array<{ bytes: Uint8Array; name: string }>): Promise<ConversionOutput> {
  if (files.length === 0) throw new ConversionFailure('至少需要一张图片', 'invalid-input')
  if (files.length > CONVERSION_LIMITS.maxFiles) throw new ConversionFailure('图片数量超过限制', 'resource-limit')
  const entries: Record<string, Uint8Array> = {}
  let total = 0
  for (const [index, file] of files.entries()) {
    checkInputSize(file.bytes)
    total += file.bytes.byteLength
    if (total > CONVERSION_LIMITS.maxZipExpandedBytes) throw new ConversionFailure('归档展开大小超过限制', 'resource-limit')
    const base = file.name.split(/[\\/]/).pop() || `image-${index + 1}.bin`
    const safe = [...base]
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0
        return code >= 0x20 && code !== 0x7f && !'\\/:*?"<>|'.includes(char)
      })
      .join('')
      .slice(0, 180) || `image-${index + 1}.bin`
    entries[`${String(index + 1).padStart(4, '0')}-${safe}`] = file.bytes
  }
  return { bytes: ensureOutputSize(zipSync(entries)), format: 'zip', mimeType: mimeTypeOf('zip') }
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

async function convertTextLike(bytes: Uint8Array, source: ConversionFormat, target: ConversionFormat): Promise<ConversionOutput> {
  const input = textOf(bytes)
  const from = source as string
  const to = target as string
  let output: string
  try {
    if (from === 'json' && to === 'yaml') output = stringifyYaml(JSON.parse(input))
    else if (from === 'yaml' && to === 'json') output = `${JSON.stringify(parseYaml(input), null, 2)}\n`
    else if (from === 'json' && to === 'txt') output = `${JSON.stringify(JSON.parse(input), null, 2)}\n`
    else if (from === 'yaml' && to === 'txt') output = `${JSON.stringify(parseYaml(input), null, 2)}\n`
    else if (from === 'csv' && to === 'tsv') output = input.replaceAll(',', '\t')
    else if (from === 'tsv' && to === 'csv') output = input.replaceAll('\t', ',')
    else if ((to === 'txt' || to === 'md' || to === 'log') && from !== 'html') output = input
    else if (from === 'md' && to === 'html') output = `<pre>${escapeHtml(input)}</pre>\n`
    else if (from === 'html' && to === 'txt') output = input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n'
    else if (from === to || (from === 'markdown' && to === 'md') || (from === 'yml' && to === 'yaml')) output = input
    else throw new ConversionFailure('该文本格式组合暂不支持', 'unsupported-format')
  } catch (error) {
    if (error instanceof ConversionFailure) throw error
    throw new ConversionFailure('文本内容格式无效', 'invalid-input')
  }
  return { bytes: ensureOutputSize(new TextEncoder().encode(output)), format: target, mimeType: mimeTypeOf(target) }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

export async function convertOfficeDocument(
  bytes: Uint8Array,
  sourceName: string,
  target: ConversionFormat,
  signal?: AbortSignal
): Promise<ConversionOutput> {
  checkInputSize(bytes)
  const source = conversionExtension(sourceName)
  if (!OFFICEPARSER_INPUTS.has(source) || !OFFICEPARSER_OUTPUTS.has(target)) {
    throw new ConversionFailure('该文件格式或目标格式未纳入文档转换引擎', 'unsupported-format')
  }
  if (signal?.aborted) throw new ConversionFailure('转换已取消', 'conversion-failed')
  try {
    const { OfficeConverter } = await import('officeparser')
    const destination = target === 'txt' ? 'text' : target
    const result = await OfficeConverter.convert(Buffer.from(bytes), destination as 'text' | 'md' | 'html' | 'pdf' | 'csv' | 'rtf' | 'epub' | 'docx' | 'odt' | 'xlsx' | 'ods' | 'pptx' | 'odp' | 'tex', {
      parseConfig: {
        fileType: source as 'docx' | 'pptx' | 'xlsx' | 'odt' | 'odp' | 'ods' | 'odg' | 'pdf' | 'rtf' | 'md' | 'html' | 'csv' | 'epub' | 'tex',
        allowRemoteAssets: false,
        extractAttachments: true,
        abortSignal: signal,
        decompressionLimits: {
          maxUncompressedBytes: CONVERSION_LIMITS.maxZipExpandedBytes,
          maxZipEntries: CONVERSION_LIMITS.maxZipEntries
        }
      },
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
  checkInputSize(bytes)
  const target = normalizeConversionFormat(targetValue)
  const source = conversionExtension(sourceName)
  if (!KNOWN_INPUTS.has(source)) throw new ConversionFailure('输入格式不受支持', 'unsupported-format')
  if (!KNOWN_INPUTS.has(target)) throw new ConversionFailure('目标格式不受支持', 'unsupported-format')
  if (IMAGE_FORMATS.has(source) && IMAGE_FORMATS.has(target)) return convertImage(bytes, sourceName, target, quality)
  if (TEXT_FORMATS.has(source) && TEXT_FORMATS.has(target)) return convertTextLike(bytes, source, target)
  if (source === 'pdf' && target === 'pdf') return { bytes, format: target, mimeType: mimeTypeOf(target) }
  try {
    return await convertOfficeDocument(bytes, sourceName, target, signal)
  } catch (error) {
    if (!(error instanceof ConversionFailure) || error.code !== 'unsupported-format') throw error
    try {
      const output = await externalConversion(bytes, sourceName, source, target, signal)
      return { bytes: ensureOutputSize(output), format: target, mimeType: mimeTypeOf(target) }
    } catch (externalError) {
      if (externalError instanceof ExternalConversionError) {
        if (externalError.message === '当前格式组合没有可用的外部转换路径') {
          throw new ConversionFailure('该输入与目标格式组合不受支持', 'unsupported-format')
        }
        throw new ConversionFailure(externalError.message, 'conversion-failed')
      }
      throw externalError
    }
  }
}
