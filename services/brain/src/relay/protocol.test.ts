import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  E2eSession,
  decodeInnerFrame,
  encodeInnerFrame,
  relayToken,
  routingToken,
  sha256Hex,
  tokenHash
} from './protocol.ts'

test('routing and token hashes are deterministic without exposing the connect code', () => {
  const code = 'relay-test-connect-code'
  const routing = routingToken(code)
  assert.match(routing, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(routing, code)
  assert.equal(tokenHash(code, true), sha256Hex(routing))
  assert.equal(relayToken(code, false), code)
  assert.equal(tokenHash(code, false), sha256Hex(code))
})

test('inner JSON and binary frames round-trip text and bytes', () => {
  const binary = new Uint8Array([0, 1, 2, 255])
  assert.deepEqual(decodeInnerFrame(encodeInnerFrame({ t: 'hchunk', id: 'h1', b: binary }, false)), {
    t: 'hchunk',
    id: 'h1',
    b: binary
  })
  assert.deepEqual(decodeInnerFrame(encodeInnerFrame({ t: 'wmsg', id: 'w1', s: '中文' }, true)), {
    t: 'wmsg',
    id: 'w1',
    s: '中文'
  })
  assert.deepEqual(decodeInnerFrame(encodeInnerFrame({ t: 'wmsg', id: 'w1', b: binary }, true)), {
    t: 'wmsg',
    id: 'w1',
    b: binary
  })
})

test('initiator and responder authenticate and exchange encrypted frames', async () => {
  const code = 'relay-e2e-test-code'
  const initiatorFrames: Record<string, unknown>[] = []
  const responderFrames: Record<string, unknown>[] = []
  const initiator = new E2eSession({
    code,
    responder: false,
    send: (frame) => responder.receive(frame),
    onFrame: (frame) => initiatorFrames.push(frame),
    onError: (message) => { throw new Error(`initiator: ${message}`) }
  })
  const responder = new E2eSession({
    code,
    responder: true,
    send: (frame) => initiator.receive(frame),
    onFrame: (frame) => responderFrames.push(frame),
    onError: (message) => { throw new Error(`responder: ${message}`) }
  })
  initiator.start()
  assert.equal(initiator.ready, true)
  assert.equal(responder.ready, true)
  initiator.sendFrame({ t: 'hreq', id: 'h1', method: 'GET', path: '/api/health' })
  responder.sendFrame({ t: 'hres', id: 'h1', status: 200 })
  assert.deepEqual(responderFrames, [{ t: 'hreq', id: 'h1', method: 'GET', path: '/api/health' }])
  assert.deepEqual(initiatorFrames, [{ t: 'hres', id: 'h1', status: 200 }])
})

test('wrong code fails authentication before any business frame', () => {
  const sent: unknown[] = []
  let initiatorError = ''
  let responderError = ''
  const initiator = new E2eSession({
    code: 'wrong-code',
    responder: false,
    send: (frame) => responder.receive(frame),
    onFrame: () => assert.fail('business frame must not arrive'),
    onError: (message) => { initiatorError = message }
  })
  const responder = new E2eSession({
    code: 'correct-code',
    responder: true,
    send: (frame) => {
      sent.push(frame)
      initiator.receive(frame)
    },
    onFrame: () => assert.fail('business frame must not arrive'),
    onError: (message) => { responderError = message }
  })
  initiator.start()
  assert.match(initiatorError, /authentication|E2E/i)
  assert.equal(responderError, '')
  assert.equal(initiator.ready, false)
  assert.equal(responder.ready, false)
  assert.equal(sent.length, 1)
})

test('outer protocol 1 base64 strings carry the handshake and encrypted frames', () => {
  const code = 'relay-base64-outer-code'
  const initiatorFrames: Record<string, unknown>[] = []
  const responderFrames: Record<string, unknown>[] = []
  const errors: string[] = []
  // Protocol 1 has no binary agent frames: ciphertext arrives as base64 text.
  const outer = (payload: string | Uint8Array): string =>
    typeof payload === 'string' ? payload : Buffer.from(payload).toString('base64')
  const initiator = new E2eSession({
    code,
    responder: false,
    send: (payload) => responder.receive(outer(payload)),
    onFrame: (frame) => initiatorFrames.push(frame),
    onError: (message) => { errors.push(`initiator: ${message}`) }
  })
  const responder = new E2eSession({
    code,
    responder: true,
    send: (payload) => initiator.receive(outer(payload)),
    onFrame: (frame) => responderFrames.push(frame),
    onError: (message) => { errors.push(`responder: ${message}`) }
  })
  initiator.start()
  assert.deepEqual(errors, [])
  assert.equal(initiator.ready, true)
  assert.equal(responder.ready, true)
  initiator.sendFrame({ t: 'wmsg', id: 'w1', s: '你好' })
  responder.sendFrame({ t: 'wmsg', id: 'w1', b: new Uint8Array([1, 2, 3]) })
  assert.deepEqual(errors, [])
  assert.deepEqual(responderFrames, [{ t: 'wmsg', id: 'w1', s: '你好' }])
  assert.deepEqual(initiatorFrames, [{ t: 'wmsg', id: 'w1', b: new Uint8Array([1, 2, 3]) }])
})

test('replayed encrypted frame fails the session without delivering it twice', () => {
  const code = 'relay-replay-test-code'
  const received: Record<string, unknown>[] = []
  const sealed: Uint8Array[] = []
  let error = ''
  const initiator = new E2eSession({
    code,
    responder: false,
    send: (payload) => {
      if (payload instanceof Uint8Array) sealed.push(payload)
      responder.receive(payload)
    },
    onFrame: () => assert.fail('initiator must not receive a business frame'),
    onError: (message) => { error = `initiator: ${message}` }
  })
  const responder = new E2eSession({
    code,
    responder: true,
    send: (payload) => initiator.receive(payload),
    onFrame: (frame) => received.push(frame),
    onError: (message) => { error = `responder: ${message}` }
  })
  initiator.start()
  assert.equal(initiator.ready, true)
  assert.equal(responder.ready, true)
  initiator.sendFrame({ t: 'wmsg', id: 'w1', s: 'first' })
  assert.equal(sealed.length, 1)
  assert.deepEqual(received, [{ t: 'wmsg', id: 'w1', s: 'first' }])
  responder.receive(sealed[0]!)
  assert.match(error, /replayed or out of order/i)
  assert.deepEqual(received, [{ t: 'wmsg', id: 'w1', s: 'first' }])
  assert.equal(responder.ready, false)
})
