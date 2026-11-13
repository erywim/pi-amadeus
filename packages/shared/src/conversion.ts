/**
 * 文件转换能力的跨端契约。
 * 能力由大脑服务运行时探测，客户端不能假定所有格式在每台机器上都可用。
 */

export type ConversionFormat =
  | 'png'
  | 'jpg'
  | 'jpeg'
  | 'webp'
  | 'avif'
  | 'tiff'
  | 'gif'
  | 'svg'
  | 'txt'
  | 'md'
  | 'markdown'
  | 'html'
  | 'json'
  | 'csv'
  | 'tsv'
  | 'log'
  | 'xml'
  | 'yaml'
  | 'yml'
  | 'tex'
  | 'doc'
  | 'docx'
  | 'odt'
  | 'rtf'
  | 'wps'
  | 'wpt'
  | 'wpd'
  | 'ofd'
  | 'odg'
  | 'xls'
  | 'xlsx'
  | 'xlsm'
  | 'ods'
  | 'et'
  | 'ett'
  | 'ppt'
  | 'pptx'
  | 'odp'
  | 'dps'
  | 'dpt'
  | 'pdf'
  | 'epub'
  | 'mobi'
  | 'zip'
  | 'mp3'
  | 'wav'
  | 'flac'
  | 'm4a'
  | 'aac'
  | 'ogg'
  | 'opus'
  | 'wma'
  | 'mp4'
  | 'mov'
  | 'mkv'
  | 'webm'
  | 'avi'
  | 'm4v'
  | 'wmv'
  | 'flv'
export type ConversionOperationId =
  | 'convert'
  | 'images-to-pdf'
  | 'images-to-zip'
  | 'merge-pdfs'
  | 'pdf-raster'
  | 'media-convert'
  | 'ocr'
  | 'office-convert'

export function normalizeConversionFormat(value: string): ConversionFormat {
  const format = value.trim().toLowerCase().replace(/^\./, '')
  if (format === 'jpeg') return 'jpg'
  if (format === 'markdown') return 'md'
  if (format === 'yml') return 'yaml'
  if (format === 'text') return 'txt'
  return format as ConversionFormat
}

export function conversionExtension(name: string): ConversionFormat {
  const extension = name.split(/[\\\\/]/).pop()?.split('.').pop() ?? ''
  return normalizeConversionFormat(extension)
}

/**
 * `ready` 表示进程内依赖已加载；`detected` 表示已找到并启用的本机适配器。
 * 两种状态都可以执行，前端只应把其它状态显示为不可用。
 */
export type ConversionCapabilityStatus = 'ready' | 'detected' | 'missing' | 'broken' | 'unsupported'

export type ConversionReasonCode =
  | 'binary-not-found'
  | 'version-probe-failed'
  | 'package-load-failed'
  | 'operation-not-enabled'
  | 'unsupported-format'
  | 'invalid-input'
  | 'resource-limit'
  | 'conversion-failed'
  | 'cancelled'

export interface ConversionEngineCapability {
  id: string
  label: string
  kind: 'package' | 'executable'
  status: ConversionCapabilityStatus
  version?: string
  reason?: ConversionReasonCode
  detail?: string
}

export interface ConversionOperationCapability {
  id: ConversionOperationId
  label: string
  inputs: ConversionFormat[]
  outputs: ConversionFormat[]
  status: ConversionCapabilityStatus
  engines: string[]
  reason?: ConversionReasonCode
}

export interface ConversionLimits {
  maxSingleFileBytes: number
  maxRequestBytes: number
  maxFiles: number
  maxPdfPages: number
  maxZipEntries: number
  maxZipExpandedBytes: number
  maxOutputBytes: number
}

export interface ConversionCapabilities {
  schemaVersion: 1
  checkedAt: number
  operations: ConversionOperationCapability[]
  engines: ConversionEngineCapability[]
  limits: ConversionLimits
}

export interface ConversionTargetsResponse {
  extension: ConversionFormat
  category: string
  operation: ConversionOperationId
  targets: ConversionFormat[]
  experimental: ConversionFormat[]
}

export interface ConversionErrorResponse {
  error: string
  code: ConversionReasonCode
  details?: Record<string, unknown>
}

export const CONVERSION_LIMITS: ConversionLimits = {
  maxSingleFileBytes: 64 * 1024 * 1024,
  maxRequestBytes: 128 * 1024 * 1024,
  maxFiles: 50,
  maxPdfPages: 500,
  maxZipEntries: 1_000,
  maxZipExpandedBytes: 256 * 1024 * 1024,
  maxOutputBytes: 512 * 1024 * 1024
}

export const CONVERSION_FORMATS = {
  image: ['png', 'jpg', 'webp', 'avif', 'tiff', 'gif', 'svg'] as ConversionFormat[],
  text: ['txt', 'md', 'html', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'tex'] as ConversionFormat[],
  office: ['doc', 'docx', 'odt', 'rtf', 'wps', 'wpt', 'wpd', 'ofd', 'odg', 'xls', 'xlsx', 'xlsm', 'ods', 'et', 'ett', 'ppt', 'pptx', 'odp', 'dps', 'dpt'] as ConversionFormat[],
  document: ['pdf', 'epub'] as ConversionFormat[],
  archive: ['zip'] as ConversionFormat[],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] as ConversionFormat[],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv'] as ConversionFormat[]
} as const
