/**
 * 文件转换 API 回归：能力发现、图片转码、图片转 PDF、PDF 合并与错误边界。
 * 输入全部在临时目录生成，避免写入用户真实数据目录。
 * 运行前：npm run dev:brain
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const brain = process.env.BRAIN_URL ?? 'http://localhost:3002'
const temp = await mkdtemp(join(tmpdir(), 'amadeus-e2e-conversion-'))

async function png2x2() {
  // Stable 2x2 RGBA PNG fixture (red pixels), assembled without external tools.
  const zlib = await import('node:zlib')
  const crc = (data) => {
    let c = 0xffffffff
    for (const byte of data) {
      c ^= byte
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    type.copy(out, 4)
    data.copy(out, 8)
    out.writeUInt32BE(crc(Buffer.concat([type, data])), 8 + data.length)
    return out
  }
  const header = Buffer.from('\x89PNG\r\n\x1a\n', 'binary')
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.concat([Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 255]), Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 255])])
  return Buffer.concat([header, chunk(Buffer.from('IHDR'), ihdr), chunk(Buffer.from('IDAT'), zlib.deflateSync(raw)), chunk(Buffer.from('IEND'), Buffer.alloc(0))])
}

async function request(path, init) {
  const response = await fetch(`${brain}${path}`, init)
  return response
}

try {
  const capabilities = await request('/api/conversion/capabilities')
  assert.equal(capabilities.status, 200)
  const capabilityBody = await capabilities.json()
  assert.equal(capabilityBody.schemaVersion, 1)
  assert.ok(capabilityBody.operations.some((item) => item.id === 'images-to-pdf'))
  assert.ok(capabilityBody.engines.some((item) => item.id === 'pdf-lib'))

  const pngPath = join(temp, 'fixture.png')
  await writeFile(pngPath, await png2x2())
  const form = new FormData()
  form.append('file', new Blob([await readFile(pngPath)], { type: 'image/png' }), 'fixture.png')
  form.append('to', 'webp')
  const converted = await request('/api/conversion/convert', { method: 'POST', body: form })
  assert.equal(converted.status, 200)
  assert.equal(converted.headers.get('content-type'), 'image/webp')
  assert.ok((await converted.arrayBuffer()).byteLength > 0)

  const imageForm = new FormData()
  imageForm.append('files', new Blob([await readFile(pngPath)], { type: 'image/png' }), 'fixture.png')
  const imagePdf = await request('/api/conversion/images-to-pdf', { method: 'POST', body: imageForm })
  assert.equal(imagePdf.status, 200)
  assert.equal(imagePdf.headers.get('content-type'), 'application/pdf')
  const pdfBytes = Buffer.from(await imagePdf.arrayBuffer())
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-')

  const mergeForm = new FormData()
  mergeForm.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'a.pdf')
  mergeForm.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'b.pdf')
  const merged = await request('/api/conversion/merge-pdfs', { method: 'POST', body: mergeForm })
  assert.equal(merged.status, 200)
  assert.equal(merged.headers.get('content-type'), 'application/pdf')
  assert.equal(Buffer.from(await merged.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')

  const unsupportedForm = new FormData()
  unsupportedForm.append('file', new Blob([Buffer.from('not an image')]), 'fixture.txt')
  unsupportedForm.append('to', 'webp')
  const unsupported = await request('/api/conversion/convert', { method: 'POST', body: unsupportedForm })
  assert.equal(unsupported.status, 415)
  const errorBody = await unsupported.json()
  assert.equal(errorBody.code, 'unsupported-format')

  console.log('PASS conversion API: capabilities, image, PDF, merge, unsupported input')
} finally {
  await rm(temp, { recursive: true, force: true })
}
