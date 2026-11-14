import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { test } from 'node:test'
import { WebSocketServer, WebSocket } from 'ws'
import { E2eSession } from './protocol.ts'
import {
  BINARY_FRAME,
  RELAY_ORIGIN_HEADER,
  RELAY_ORIGIN_VALUE,
  RelayClient,
  clientProtocolOffer,
  decodeRelayBase64,
  localRelayPath,
  parseRelayBinaryFrame,
  relayProtocolFor,
  relayRequestHeaders
} from './client.ts'

type JsonFrame = Record<string, unknown>

function relayFrame(kind: number, id: string, payload: Uint8Array): Uint8Array {
  const idBytes = Buffer.from(id)
  return Uint8Array.from([kind, idBytes.byteLength, ...idBytes, ...payload])
}

function base64Bytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(String(value ?? ''), 'base64'))
}

async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() >= deadline) throw new Error(`等待超时: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface LocalRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: Uint8Array
}

class LocalApi {
  readonly server: Server
  readonly sockets: WebSocket[] = []
  readonly requests: LocalRequest[] = []
  readonly ready: Promise<number>
  private readonly wss: WebSocketServer

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = new Uint8Array(Buffer.concat(chunks))
        this.requests.push({
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers: request.headers,
          body
        })
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({
          method: request.method,
          url: request.url,
          body: Buffer.from(body).toString('base64'),
          host: request.headers.host ?? null,
          authorization: request.headers.authorization ?? null,
          cookie: request.headers.cookie ?? null,
          marker: request.headers[RELAY_ORIGIN_HEADER] ?? null,
          acceptEncoding: request.headers['accept-encoding'] ?? null
        }))
      })
    })
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (socket) => this.sockets.push(socket))
    this.ready = new Promise((resolve, reject) => {
      this.server.once('listening', () => {
        const address = this.server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('local api has no address'))
      })
      this.server.once('error', reject)
    })
    this.server.listen(0, '127.0.0.1')
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

class FakeRelay {
  readonly server: WebSocketServer
  readonly ready: Promise<string>
  readonly connected: Promise<void>
  readonly json: JsonFrame[] = []
  readonly binary: Uint8Array[] = []
  onJson: ((frame: JsonFrame) => void) | null = null
  onBinary: ((frame: Uint8Array) => void) | null = null
  socket: WebSocket | null = null

  constructor(reply: (register: JsonFrame) => JsonFrame) {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    this.ready = new Promise((resolve, reject) => {
      this.server.once('listening', () => {
        const address = this.server.address()
        if (address && typeof address === 'object') resolve(`http://127.0.0.1:${address.port}`)
        else reject(new Error('fake relay has no address'))
      })
      this.server.once('error', reject)
    })
    let resolveConnected: () => void = () => {}
    this.connected = new Promise((resolve) => { resolveConnected = resolve })
    this.server.on('connection', (socket) => {
      this.socket = socket
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          const bytes = new Uint8Array(data as Buffer)
          this.binary.push(bytes)
          this.onBinary?.(bytes)
          return
        }
        const frame = JSON.parse(data.toString()) as JsonFrame
        this.json.push(frame)
        if (frame.t === 'register') socket.send(JSON.stringify(reply(frame)))
        this.onJson?.(frame)
      })
      resolveConnected()
    })
  }

  send(frame: JsonFrame): void {
    this.socket?.send(JSON.stringify(frame))
  }

  sendBinary(frame: Uint8Array): void {
    this.socket?.send(frame, { binary: true })
  }

  async nextJson(predicate: (frame: JsonFrame) => boolean, label: string, timeoutMs = 5_000): Promise<JsonFrame> {
    return waitFor(() => this.json.find(predicate), label, timeoutMs)
  }

  async close(): Promise<void> {
    this.socket?.terminate()
    this.socket = null
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function makeClient(relayUrl: string, localPort: number, e2eEncryption: boolean, userId?: string): RelayClient {
  return new RelayClient({
    serverUrl: relayUrl,
    connectCode: 'relay-client-test-code-0123456789',
    registrationKey: '',
    localPort,
    deviceName: 'test-desktop',
    e2eEncryption,
    ...(userId ? { userId } : {})
  })
}

test('helper 策略：base64、管理路径、请求头与协议', () => {
  assert.deepEqual([...decodeRelayBase64('AQID/w==')!], [1, 2, 3, 255])
  assert.deepEqual([...decodeRelayBase64('AQID_w')!], [1, 2, 3, 255])
  assert.equal(decodeRelayBase64('')?.byteLength, 0)
  assert.equal(decodeRelayBase64('A'), null)
  assert.equal(decodeRelayBase64('not base64!'), null)
  assert.equal(decodeRelayBase64([]), null)

  assert.equal(localRelayPath('/api/health'), '/api/health')
  assert.equal(localRelayPath('/api/agents?userId=u1'), '/api/agents?userId=u1')
  for (const blocked of [
    '/api/relay',
    '/api/relay/status',
    '/API/RELAY/status',
    '/api/collaboration/pairing',
    '/api/mobile-relay/enable',
    '/%61pi/relay',
    '/api/%72elay',
    '/api/relay%2Fstatus',
    '/api%2Frelay',
    '/api//relay',
    '/api/./relay',
    '/api/x/../relay',
    '/api/%2e%2e/relay',
    '/api/%252e%252e/relay',
    '/api\\relay',
    '/api/%5c..%5crelay',
    '/api/relay%00',
    '/api/chat',
    '/api/socket',
    '/etc/passwd',
    '/',
    '//evil.test/api/health',
    'http://evil.test/api/health'
  ]) {
    assert.throws(() => localRelayPath(blocked), /Relay/, blocked)
  }

  const headers = relayRequestHeaders({
    Host: 'evil.test',
    Authorization: 'Bearer admin',
    Cookie: 'session=1',
    'X-Forwarded-For': '203.0.113.9',
    Forwarded: 'for=203.0.113.9',
    [RELAY_ORIGIN_HEADER]: 'spoofed',
    'Content-Type': 'application/json',
    'X-Custom': 'kept',
    'X-Numeric': 42
  })
  assert.equal(headers.host, undefined)
  assert.equal(headers.authorization, undefined)
  assert.equal(headers.cookie, undefined)
  assert.equal(headers['x-forwarded-for'], undefined)
  assert.equal(headers.forwarded, undefined)
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['x-custom'], 'kept')
  assert.equal(headers['x-numeric'], undefined)
  assert.equal(headers['accept-encoding'], 'identity')
  assert.equal(headers[RELAY_ORIGIN_HEADER], RELAY_ORIGIN_VALUE)

  const payload = Uint8Array.from([9, 8, 7])
  const binary = parseRelayBinaryFrame(relayFrame(BINARY_FRAME.HBODY, 'h1', payload))
  assert.equal(binary?.kind, BINARY_FRAME.HBODY)
  assert.equal(binary?.id, 'h1')
  assert.deepEqual([...(binary?.data ?? [])], [9, 8, 7])
  assert.equal(parseRelayBinaryFrame(Uint8Array.from([BINARY_FRAME.HBODY])), null)
  assert.equal(parseRelayBinaryFrame(Uint8Array.from([BINARY_FRAME.HBODY, 5, 1])), null)

  assert.equal(clientProtocolOffer(undefined), 2)
  assert.equal(clientProtocolOffer(1), 1)
  assert.equal(clientProtocolOffer(2), 2)
  assert.equal(clientProtocolOffer(9), 2)
  assert.equal(relayProtocolFor(undefined), 1)
  assert.equal(relayProtocolFor(1), 1)
  assert.equal(relayProtocolFor(2), 2)
  assert.equal(relayProtocolFor(3), 2)
})

test('协议 1 回退：解码 hreq/wmsg 的 base64，拒绝管理路径，剥离 Host/Authorization', async (t) => {
  const local = new LocalApi()
  const port = await local.ready
  const relay = new FakeRelay(() => ({ t: 'registered' }))
  const relayUrl = await relay.ready
  const client = makeClient(relayUrl, port, false)
  t.after(async () => {
    client.stop()
    await relay.close()
    await local.close()
  })

  client.start()
  await relay.connected
  const register = await relay.nextJson((frame) => frame.t === 'register', 'register')
  // 默认主动提出协议 2；老 Relay 不回答 `proto`，客户端必须回落到协议 1。
  assert.equal(register.proto, 2)
  await waitFor(() => client.status().state === 'connected', 'client connected')

  const requestBody = Buffer.from('{"hello":"世界"}')
  relay.send({
    t: 'hreq',
    id: 'h1',
    method: 'POST',
    path: '/api/health?x=1',
    headers: {
      Host: 'evil.test',
      Authorization: 'Bearer admin',
      Cookie: 'session=1',
      [RELAY_ORIGIN_HEADER]: 'spoofed',
      'content-type': 'application/json'
    },
    b: requestBody.toString('base64')
  })
  const head = await relay.nextJson((frame) => frame.t === 'hres' && frame.id === 'h1', 'hreq response head')
  assert.equal(head.status, 200)
  await relay.nextJson((frame) => frame.t === 'hend' && frame.id === 'h1', 'hreq response end')

  const request = await waitFor(() => local.requests[0], 'local request')
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/api/health?x=1')
  assert.deepEqual([...request.body], [...requestBody])
  assert.equal(request.headers.authorization, undefined)
  assert.equal(request.headers.cookie, undefined)
  assert.equal(request.headers[RELAY_ORIGIN_HEADER], RELAY_ORIGIN_VALUE)
  assert.match(request.headers.host ?? '', /^127\.0\.0\.1:\d+$/)

  const responseChunks = relay.json.filter((frame) => frame.t === 'hchunk' && frame.id === 'h1')
  const responseText = Buffer.concat(responseChunks.map((frame) => base64Bytes(frame.b))).toString('utf8')
  assert.equal((JSON.parse(responseText) as { body: string }).body, requestBody.toString('base64'))

  relay.send({ t: 'wopen', id: 's1', path: '/api/agents' })
  await relay.nextJson((frame) => frame.t === 'wopened' && frame.id === 's1', 'wopen')
  const socket = await waitFor(() => local.sockets[0], 'local socket')
  const received: Uint8Array[] = []
  socket.on('message', (data, isBinary) => received.push(isBinary ? new Uint8Array(data as Buffer) : Buffer.from(data.toString())))
  relay.send({ t: 'wmsg', id: 's1', b: Buffer.from([0, 1, 2, 255]).toString('base64') })
  const incoming = await waitFor(() => received[0], 'phone binary message')
  assert.deepEqual([...incoming], [0, 1, 2, 255])

  socket.send(Uint8Array.from([9, 8, 7]))
  const outgoing = await relay.nextJson((frame) => frame.t === 'wmsg' && frame.id === 's1', 'local binary message')
  assert.deepEqual([...base64Bytes(outgoing.b)], [9, 8, 7])

  const requestsBeforeBlock = local.requests.length
  const blockedPaths = [
    '/api/relay/status',
    '/api/collaboration/pairing',
    '/api/chat',
    '/api/%72elay/status',
    '/api/x/../relay/status',
    '/api/%2e%2e/relay/status',
    '/api/mobile-relay/enable',
    '/etc/passwd',
    '//evil.test/api/health'
  ]
  for (const [index, blocked] of blockedPaths.entries()) {
    const id = `blocked-${index}`
    relay.send({ t: 'hreq', id, method: 'GET', path: blocked })
    const denied = await relay.nextJson((frame) => frame.t === 'hres' && frame.id === id, `denied ${blocked}`)
    assert.equal(denied.status, 403, blocked)
    await relay.nextJson((frame) => frame.t === 'hend' && frame.id === id, `denied end ${blocked}`)
  }
  assert.equal(local.requests.length, requestsBeforeBlock)

  relay.send({ t: 'wclose', id: 's1' })
})

test('E2E 开启时拒绝明文 hreq 和非 E2E wopen', async (t) => {
  const local = new LocalApi()
  const port = await local.ready
  const relay = new FakeRelay(() => ({ t: 'registered' }))
  const relayUrl = await relay.ready
  const client = makeClient(relayUrl, port, true)
  t.after(async () => {
    client.stop()
    await relay.close()
    await local.close()
  })

  client.start()
  await relay.connected
  await relay.nextJson((frame) => frame.t === 'register', 'register')
  await waitFor(() => client.status().state === 'connected', 'client connected')

  relay.send({ t: 'hreq', id: 'plain', method: 'GET', path: '/api/health' })
  const denied = await relay.nextJson((frame) => frame.t === 'hres' && frame.id === 'plain', 'plaintext denied')
  assert.equal(denied.status, 403)
  await relay.nextJson((frame) => frame.t === 'hend' && frame.id === 'plain', 'plaintext denied end')
  assert.equal(local.requests.length, 0)

  relay.send({ t: 'wopen', id: 'plain-ws', path: '/api/relay/status' })
  const rejected = await relay.nextJson((frame) => frame.t === 'werr' && frame.id === 'plain-ws', 'plaintext ws rejected')
  assert.equal(rejected.t, 'werr')
  assert.equal(local.sockets.length, 0)
})

test('E2E responder 独立分发：内层 HTTP/WS 不混入外层 Relay 帧', async (t) => {
  const local = new LocalApi()
  const port = await local.ready
  const relay = new FakeRelay(() => ({ t: 'registered' }))
  const relayUrl = await relay.ready
  const code = 'relay-client-test-code-0123456789'
  const client = makeClient(relayUrl, port, true, 'relay-user')
  const phoneFrames: JsonFrame[] = []
  const phoneErrors: string[] = []
  const phone = new E2eSession({
    code,
    responder: false,
    send: (payload) => {
      relay.send(payload instanceof Uint8Array
        ? { t: 'wmsg', id: 'e2e', b: Buffer.from(payload).toString('base64') }
        : { t: 'wmsg', id: 'e2e', s: payload })
    },
    onFrame: (frame) => phoneFrames.push(frame),
    onError: (message) => phoneErrors.push(message)
  })
  relay.onJson = (frame) => {
    if (frame.t !== 'wmsg' || frame.id !== 'e2e') return
    if (typeof frame.s === 'string') phone.receive(frame.s)
    else if (typeof frame.b === 'string') phone.receive(base64Bytes(frame.b))
  }
  t.after(async () => {
    client.stop()
    await relay.close()
    await local.close()
  })

  client.start()
  await relay.connected
  await relay.nextJson((frame) => frame.t === 'register', 'register')
  await waitFor(() => client.status().state === 'connected', 'client connected')

  relay.send({ t: 'wopen', id: 'e2e', path: '/__alma_e2e__' })
  await relay.nextJson((frame) => frame.t === 'wopened' && frame.id === 'e2e', 'e2e opened')
  phone.start()
  await waitFor(() => phone.ready || phoneErrors.length > 0, 'e2e handshake')
  assert.deepEqual(phoneErrors, [])
  assert.equal(phone.ready, true)

  phone.sendFrame({
    t: 'hreq',
    id: 'inner-1',
    method: 'GET',
    path: '/api/health?from=e2e',
    headers: {
      Host: 'evil.test',
      Authorization: 'Bearer admin',
      Cookie: 'session=1',
      [RELAY_ORIGIN_HEADER]: 'spoofed',
      'content-type': 'application/json'
    },
    b: undefined
  })
  await waitFor(() => phoneFrames.find((frame) => frame.t === 'hend' && frame.id === 'inner-1'), 'inner http end')
  const innerHead = phoneFrames.find((frame) => frame.t === 'hres' && frame.id === 'inner-1')
  assert.equal(innerHead?.status, 200)
  const innerChunks = phoneFrames.filter((frame) => frame.t === 'hchunk' && frame.id === 'inner-1')
  const innerText = Buffer.concat(innerChunks.map((frame) => Buffer.from(frame.b as Uint8Array))).toString('utf8')
  assert.equal((JSON.parse(innerText) as { method: string }).method, 'GET', JSON.stringify(phoneFrames))
  const innerRequest = local.requests.at(-1)!
  assert.equal(innerRequest.headers.authorization, undefined)
  assert.equal(innerRequest.headers.cookie, undefined)
  assert.equal(innerRequest.headers[RELAY_ORIGIN_HEADER], RELAY_ORIGIN_VALUE)
  assert.match(innerRequest.headers.host ?? '', /^127\.0\.0\.1:\d+$/)

  const requestsBeforeBlock = local.requests.length
  phone.sendFrame({ t: 'hreq', id: 'inner-admin', method: 'GET', path: '/api/collaboration/pairing' })
  const innerDenied = await waitFor(
    () => phoneFrames.find((frame) => frame.t === 'hres' && frame.id === 'inner-admin'),
    'inner admin denied'
  )
  assert.equal(innerDenied.status, 403)
  await waitFor(() => phoneFrames.find((frame) => frame.t === 'hend' && frame.id === 'inner-admin'), 'inner admin end')
  assert.equal(local.requests.length, requestsBeforeBlock)

  phone.sendFrame({ t: 'hreq', id: 'inner-stream', method: 'POST', path: '/api/agents', stream: true })
  await waitFor(() => phoneFrames.find((frame) => frame.t === 'herr' && frame.id === 'inner-stream'), 'inner stream rejected')

  phone.sendFrame({ t: 'wopen', id: 'inner-ws', path: '/api/agents' })
  await waitFor(() => phoneFrames.find((frame) => frame.t === 'wopened' && frame.id === 'inner-ws'), 'inner ws opened')
  const innerSocket = await waitFor(() => local.sockets.at(-1), 'inner local socket')
  const innerMessages: Uint8Array[] = []
  innerSocket.on('message', (data, isBinary) => innerMessages.push(isBinary ? new Uint8Array(data as Buffer) : Buffer.from(data.toString())))
  phone.sendFrame({ t: 'wmsg', id: 'inner-ws', b: Uint8Array.from([1, 2, 3]) })
  const innerIncoming = await waitFor(() => innerMessages[0], 'inner ws message')
  assert.deepEqual([...innerIncoming], [1, 2, 3])
  innerSocket.send(Uint8Array.from([4, 5]))
  const innerOutgoing = await waitFor(
    () => phoneFrames.find((frame) => frame.t === 'wmsg' && frame.id === 'inner-ws' && frame.b instanceof Uint8Array),
    'inner ws response'
  )
  assert.deepEqual([...(innerOutgoing.b as Uint8Array)], [4, 5])

  // 内层帧只能出现在加密的 wmsg 里；外层 JSON 不允许携带内层 id 的响应控制帧。
  const leaked = relay.json.filter((frame) => frame.id !== 'e2e' && ['hres', 'hchunk', 'hend', 'herr', 'wopened', 'wmsg', 'wclose', 'werr'].includes(String(frame.t)))
  assert.deepEqual(leaked, [])
  phone.sendFrame({ t: 'wclose', id: 'inner-ws' })
})

test('协议 2：协商、流式请求体与二进制 WebSocket 帧', async (t) => {
  const local = new LocalApi()
  const port = await local.ready
  const relay = new FakeRelay(() => ({ t: 'registered', proto: 2 }))
  const relayUrl = await relay.ready
  const client = makeClient(relayUrl, port, false, 'relay-user')
  t.after(async () => {
    client.stop()
    await relay.close()
    await local.close()
  })

  client.start()
  await relay.connected
  const register = await relay.nextJson((frame) => frame.t === 'register', 'register')
  assert.equal(register.proto, 2)
  await waitFor(() => client.status().state === 'connected', 'client connected')

  relay.send({ t: 'hreq', id: 'h2', method: 'POST', path: '/api/health', headers: { 'content-type': 'application/octet-stream' }, stream: true })
  relay.sendBinary(relayFrame(BINARY_FRAME.HBODY, 'h2', Uint8Array.from([1, 2])))
  relay.sendBinary(relayFrame(BINARY_FRAME.HBODY, 'h2', Uint8Array.from([3, 4])))
  await waitFor(() => relay.json.filter((frame) => frame.t === 'hack' && frame.id === 'h2').length === 2, 'upload hacks')
  relay.send({ t: 'hreqend', id: 'h2' })
  await relay.nextJson((frame) => frame.t === 'hend' && frame.id === 'h2', 'streamed response end')
  const streamed = await waitFor(() => local.requests.at(-1), 'streamed request')
  assert.equal(streamed.method, 'POST')
  assert.deepEqual([...streamed.body], [1, 2, 3, 4])

  relay.send({ t: 'wopen', id: 's2', path: '/api/agents' })
  await relay.nextJson((frame) => frame.t === 'wopened' && frame.id === 's2', 'ws opened')
  const socket = await waitFor(() => local.sockets.at(-1), 'protocol 2 local socket')
  const messages: Array<{ binary: boolean; data: Uint8Array | string }> = []
  socket.on('message', (data, isBinary) => {
    messages.push({ binary: isBinary, data: isBinary ? new Uint8Array(data as Buffer) : data.toString() })
  })
  relay.sendBinary(relayFrame(BINARY_FRAME.WBIN, 's2', Uint8Array.from([7, 7])))
  const binaryMessage = await waitFor(() => messages[0], 'binary ws frame')
  assert.equal(binaryMessage.binary, true)
  assert.deepEqual([...(binaryMessage.data as Uint8Array)], [7, 7])
  relay.sendBinary(relayFrame(BINARY_FRAME.WTEXT, 's2', Buffer.from('你好')))
  const textMessage = await waitFor(() => messages[1], 'text ws frame')
  assert.equal(textMessage.binary, false)
  assert.equal(textMessage.data, '你好')

  socket.send(Uint8Array.from([9]))
  const outgoingBinary = await relay.nextJson((frame) => frame.t === 'wmsg' && frame.id === 's2', 'binary ws response')
  assert.deepEqual([...base64Bytes(outgoingBinary.b)], [9])
  socket.send('回传')
  const outgoingText = await relay.nextJson(
    (frame) => frame.t === 'wmsg' && frame.id === 's2' && typeof frame.s === 'string',
    'text ws response'
  )
  assert.equal(outgoingText.s, '回传')
})
