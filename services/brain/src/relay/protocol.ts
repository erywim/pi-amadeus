import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'

const LABEL = 'alma-relay-e2e/v1'
const ROUTING_SALT = `${LABEL}/routing`
const MAGIC = 0
const RESPONSE_CHUNK_BYTES = 32 * 1024
const REQUEST_BODY_BYTES = 128 * 1024 * 1024

type JsonRecord = Record<string, unknown>
export type RelayPayload = string | Uint8Array

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function fromBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function hash(value: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value).digest())
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Alma-compatible E2E routing token: the relay only sees a one-way hash. */
export function routingToken(connectCode: string): string {
  const derived = Buffer.from(
    hkdfSync('sha256', Buffer.from(connectCode), Buffer.from(ROUTING_SALT), Buffer.alloc(0), 16)
  )
  return derived.toString('base64url')
}

export function relayToken(connectCode: string, e2eEncryption: boolean): string {
  return e2eEncryption ? routingToken(connectCode) : connectCode
}

export function tokenHash(connectCode: string, e2eEncryption: boolean): string {
  return sha256Hex(relayToken(connectCode, e2eEncryption))
}

interface RecordKeys {
  send: Uint8Array
  receive: Uint8Array
  confirmResponder: Uint8Array
  confirmInitiator: Uint8Array
}

function hkdf(shared: Uint8Array, salt: string, info: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', Buffer.from(shared), Buffer.from(salt), Buffer.from(info), 32))
}

function keyMaterial(input: {
  privateKey: ReturnType<typeof createECDH>
  peerPublicKey: Uint8Array
  code: string
  initiatorPublicKey: Uint8Array
  responderPublicKey: Uint8Array
  initiatorNonce: Uint8Array
  responderNonce: Uint8Array
  responder: boolean
}): RecordKeys {
  const shared = input.privateKey.computeSecret(Buffer.from(input.peerPublicKey))
  const transcript = hash(
    concat(
      bytes(LABEL),
      input.initiatorPublicKey,
      input.responderPublicKey,
      input.initiatorNonce,
      input.responderNonce
    )
  )
  const c2s = hkdf(shared, input.code, concat(bytes('c2s|'), transcript))
  const s2c = hkdf(shared, input.code, concat(bytes('s2c|'), transcript))
  const confirmResponder = hkdf(shared, input.code, concat(bytes('confirm-r|'), transcript))
  const confirmInitiator = hkdf(shared, input.code, concat(bytes('confirm-i|'), transcript))
  return {
    send: input.responder ? s2c : c2s,
    receive: input.responder ? c2s : s2c,
    confirmResponder,
    confirmInitiator
  }
}

class RecordStream {
  private sendCounter = 0n
  private receiveCounter = -1n
  private readonly sendKey: Uint8Array
  private readonly receiveKey: Uint8Array

  constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    this.sendKey = sendKey
    this.receiveKey = receiveKey
  }

  seal(plain: Uint8Array): Uint8Array {
    const iv = Buffer.alloc(12)
    iv.writeBigUInt64BE(this.sendCounter++, 4)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(this.sendKey), iv)
    const encrypted = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()])
    return concat(new Uint8Array(iv), new Uint8Array(encrypted), new Uint8Array(cipher.getAuthTag()))
  }

  open(frame: Uint8Array): Uint8Array {
    if (frame.byteLength < 12 + 16) throw new Error('E2E frame too short')
    const iv = frame.subarray(0, 12)
    const counter = Buffer.from(iv).readBigUInt64BE(4)
    if (counter <= this.receiveCounter) throw new Error('E2E frame replayed or out of order')
    const ciphertext = frame.subarray(12, -16)
    const tag = frame.subarray(-16)
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.receiveKey), Buffer.from(iv))
    decipher.setAuthTag(Buffer.from(tag))
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()])
    this.receiveCounter = counter
    return new Uint8Array(plain)
  }
}

function normalizePayload(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === 'string') return fromBase64url(value)
  return null
}

export function encodeInnerFrame(frame: JsonRecord, binary: boolean): Uint8Array {
  const payload = normalizePayload(frame.b)
  if (binary && payload) {
    const header: JsonRecord = { ...frame, $: 'b' }
    delete header.b
    const headerBytes = bytes(JSON.stringify(header))
    const result = new Uint8Array(5 + headerBytes.byteLength + payload.byteLength)
    result[0] = MAGIC
    new DataView(result.buffer).setUint32(1, headerBytes.byteLength)
    result.set(headerBytes, 5)
    result.set(payload, 5 + headerBytes.byteLength)
    return result
  }
  if (binary && frame.t === 'wmsg' && typeof frame.s === 'string') {
    const header: JsonRecord = { ...frame, $: 's' }
    delete header.s
    const headerBytes = bytes(JSON.stringify(header))
    const payloadBytes = bytes(frame.s)
    const result = new Uint8Array(5 + headerBytes.byteLength + payloadBytes.byteLength)
    result[0] = MAGIC
    new DataView(result.buffer).setUint32(1, headerBytes.byteLength)
    result.set(headerBytes, 5)
    result.set(payloadBytes, 5 + headerBytes.byteLength)
    return result
  }
  const json: JsonRecord = { ...frame }
  if (payload) json.b = base64url(payload)
  return bytes(JSON.stringify(json))
}

export function decodeInnerFrame(value: Uint8Array): JsonRecord {
  if (value.byteLength > 0 && value[0] === MAGIC) {
    if (value.byteLength < 5) throw new Error('E2E frame header truncated')
    const headerSize = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(1)
    if (5 + headerSize > value.byteLength) throw new Error('E2E frame header truncated')
    const header = JSON.parse(text(value.subarray(5, 5 + headerSize))) as JsonRecord
    const payload = value.subarray(5 + headerSize)
    if (header.$ === 's') header.s = text(payload)
    else if (header.$ === 'b') header.b = payload
    delete header.$
    return header
  }
  const json = JSON.parse(text(value)) as JsonRecord
  if (typeof json.b === 'string') json.b = fromBase64url(json.b)
  return json
}

interface E2eSessionOptions {
  code: string
  responder: boolean
  send: (payload: RelayPayload) => void
  onFrame: (frame: JsonRecord) => void
  onError: (message: string) => void
}

/** Authenticated P-256/HKDF/AES-GCM session used by relay WebSocket tunnels. */
export class E2eSession {
  private state: 'init' | 'await-hi' | 'await-ok' | 'ready' | 'failed' = 'init'
  private readonly nonce = randomBytes(16)
  private ecdh: ReturnType<typeof createECDH> | null = null
  private keys: RecordKeys | null = null
  private record: RecordStream | null = null
  private binary = false
  private readonly pending: JsonRecord[] = []
  private readonly options: E2eSessionOptions

  constructor(options: E2eSessionOptions) {
    this.options = options
  }

  get ready(): boolean {
    return this.state === 'ready'
  }

  start(): void {
    if (this.options.responder) return
    this.ecdh = createECDH('prime256v1')
    this.ecdh.generateKeys()
    this.state = 'await-hi'
    this.options.send(
      JSON.stringify({
        t: 'hi',
        epk: base64url(new Uint8Array(this.ecdh.getPublicKey(undefined, 'uncompressed'))),
        n: base64url(this.nonce),
        bin: 1
      })
    )
  }

  receive(payload: RelayPayload): void {
    if (this.state === 'failed') return
    try {
      // Before the handshake, text frames are JSON; once records flow, outer
      // relay protocol 1 may hand them over as base64 text instead of bytes.
      if (typeof payload === 'string' && !this.record) {
        this.receiveHandshake(JSON.parse(payload) as JsonRecord)
        return
      }
      if (!this.record) throw new Error('E2E data arrived before handshake')
      const frame = typeof payload === 'string' ? fromBase64url(payload) : payload
      this.options.onFrame(decodeInnerFrame(this.record.open(frame)))
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  sendFrame(frame: JsonRecord): void {
    if (this.state !== 'ready' || !this.record) {
      if (this.state !== 'failed') this.pending.push(frame)
      return
    }
    try {
      this.options.send(this.record.seal(encodeInnerFrame(frame, this.binary)))
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private receiveHandshake(frame: JsonRecord): void {
    if (this.options.responder && frame.t === 'hi' && this.state === 'init') {
      const peerPublic = fromBase64url(String(frame.epk ?? ''))
      const peerNonce = fromBase64url(String(frame.n ?? ''))
      this.binary = frame.bin === 1
      this.ecdh = createECDH('prime256v1')
      this.ecdh.generateKeys()
      const ownPublic = new Uint8Array(this.ecdh.getPublicKey(undefined, 'uncompressed'))
      this.keys = keyMaterial({
        privateKey: this.ecdh,
        peerPublicKey: peerPublic,
        code: this.options.code,
        initiatorPublicKey: peerPublic,
        responderPublicKey: ownPublic,
        initiatorNonce: peerNonce,
        responderNonce: this.nonce,
        responder: true
      })
      this.state = 'await-ok'
      this.options.send(JSON.stringify({ t: 'hi', epk: base64url(ownPublic), n: base64url(this.nonce), cr: base64url(this.keys.confirmResponder), ...(this.binary ? { bin: 1 } : {}) }))
      return
    }
    if (!this.options.responder && frame.t === 'hi' && this.state === 'await-hi') {
      if (!this.ecdh) throw new Error('E2E initiator key missing')
      const peerPublic = fromBase64url(String(frame.epk ?? ''))
      const peerNonce = fromBase64url(String(frame.n ?? ''))
      const ownPublic = new Uint8Array(this.ecdh.getPublicKey(undefined, 'uncompressed'))
      this.binary = this.binary && frame.bin === 1
      this.keys = keyMaterial({
        privateKey: this.ecdh,
        peerPublicKey: peerPublic,
        code: this.options.code,
        initiatorPublicKey: ownPublic,
        responderPublicKey: peerPublic,
        initiatorNonce: this.nonce,
        responderNonce: peerNonce,
        responder: false
      })
      if (!equalBytes(fromBase64url(String(frame.cr ?? '')), this.keys.confirmResponder)) throw new Error('E2E handshake authentication failed')
      this.options.send(JSON.stringify({ t: 'ok', ci: base64url(this.keys.confirmInitiator) }))
      this.readySession()
      return
    }
    if (this.options.responder && frame.t === 'ok' && this.state === 'await-ok' && this.keys) {
      if (!equalBytes(fromBase64url(String(frame.ci ?? '')), this.keys.confirmInitiator)) throw new Error('E2E handshake authentication failed')
      this.readySession()
      return
    }
    if (frame.t === 'err') throw new Error(String(frame.message ?? 'E2E peer rejected handshake'))
  }

  private readySession(): void {
    if (!this.keys) throw new Error('E2E keys missing')
    this.record = new RecordStream(this.keys.send, this.keys.receive)
    this.state = 'ready'
    const pending = this.pending.splice(0)
    for (const frame of pending) this.sendFrame(frame)
  }

  private fail(message: string): void {
    if (this.state === 'failed') return
    this.state = 'failed'
    this.options.onError(message)
  }
}

export { REQUEST_BODY_BYTES, RESPONSE_CHUNK_BYTES }
