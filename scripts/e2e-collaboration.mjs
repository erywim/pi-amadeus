/**
 * PIAM-6：本机启用 → 一次性配对 → 独立 LAN 网关 bearer/角色/用户边界 → 双设备事件收敛 → 撤销/停用。
 * 只用独立 brain、临时 DB/目录和安全本地 fixture；不接触真实设备、认证或付费 API。
 * 用法：node scripts/e2e-collaboration.mjs；无桌面端/浏览器前置，视觉 QA 由桌面端专项承担。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { URL } from 'node:url'
import { runCases, waitFor } from './agent-test-harness.mjs'

await runCases('collaboration', async (h, check) => {
  const userId = await h.user('piam-collaboration-owner')
  const otherUser = await h.user('piam-collaboration-other')
  const localStatus = `/api/collaboration/status?userId=${userId}`
  let gateway
  let observer
  let controller
  let otherDevice
  let localOnly
  let remoteSafe
  let localTask
  const auth = (device) => ({ Authorization: `Bearer ${device.token}` })
  const remote = (device, path, options = {}) => h.request(path, {
    base: gateway, headers: auth(device), ...options
  })

  async function pair(role, user = userId, name = `PIAM ${role}`) {
    const pairing = await h.request('/api/collaboration/pairing', { method: 'POST', body: { userId: user, role } })
    assert.equal(pairing.role, role)
    assert.ok(pairing.expiresAt > Date.now())
    const result = await h.request('/pair', { base: gateway, method: 'POST', body: { code: pairing.code, name }, status: 201 })
    assert.equal(result.device.role, role)
    assert.equal(result.device.userId, user)
    assert.ok(result.token.length >= 40)
    return { ...result, code: pairing.code }
  }

  await check('gateway disabled by default; local-only enable/port/Origin boundaries', async () => {
    assert.equal((await h.request(localStatus)).enabled, false)
    await h.request('/api/collaboration/pairing', { method: 'POST', body: { userId, role: 'observer' }, status: 409 })
    for (const origin of ['null', 'https://untrusted.example']) {
      await h.request('/api/collaboration/enable', { method: 'POST', body: { port: 0 }, headers: { Origin: origin }, status: 403 })
    }
    await h.request('/api/collaboration/enable', { method: 'POST', body: { port: -1 }, status: 400 })
    const status = await h.request('/api/collaboration/enable', { method: 'POST', body: { port: 0 } })
    assert.equal(status.enabled, true)
    assert.equal(status.transport, 'http-lan')
    assert.ok(status.port > 0)
    assert.notEqual(status.port, Number(new URL(h.base).port))
    gateway = `http://127.0.0.1:${status.port}`
    assert.equal((await h.request(localStatus)).port, status.port)
  })

  await check('LAN client warns HTTP exposure and renders untrusted values without innerHTML', async () => {
    const response = await fetch(gateway, { signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /HTTP/i)
    assert.match(html, /(?:加密|未加密|unencrypted|not encrypted|可信|trusted)/i)
    assert.doesNotMatch(html, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/)
    assert.match(html, /textContent/)
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })

  await check('one-time pairing, invalid/missing token 401, same-origin boundary', async () => {
    observer = await pair('observer', userId, '<img src=x onerror=alert(1)> observer')
    controller = await pair('controller')
    otherDevice = await pair('observer', otherUser)
    await h.request('/pair', { base: gateway, method: 'POST', body: { code: observer.code, name: 'replay' }, status: 401 })
    await h.request('/pair', { base: gateway, method: 'POST', body: { code: 'invalid-code', name: 'invalid' }, status: 401 })
    await h.request('/api/agents', { base: gateway, status: 401 })
    await h.request('/api/agents', { base: gateway, headers: { Authorization: 'Bearer invalid' }, status: 401 })
    await h.request('/api/agents', {
      base: gateway, headers: { ...auth(observer), Origin: 'https://untrusted.example' }, status: 403
    })
    const device = (await remote(observer, '/api/device')).device
    assert.equal(device.id, observer.device.id)
    assert.equal(device.name, '<img src=x onerror=alert(1)> observer')
    const status = await h.request(localStatus)
    assert.equal(status.devices.filter((item) => item.userId === userId).length, 2)
    assert.doesNotMatch(JSON.stringify(status), new RegExp(observer.token))
  })

  await check('gateway excludes config/users/plugins/chat/files and profile management', async () => {
    const forbidden = [
      ['GET', '/api/config'], ['POST', '/api/config'], ['GET', '/api/users/current'], ['POST', '/api/users/resolve'],
      ['GET', '/api/plugins'], ['POST', '/api/chat'], ['GET', '/api/sessions'], ['GET', '/api/skills'],
      ['GET', '/api/providers'], ['GET', '/api/files'], ['GET', '/api/file?path=/etc/passwd'],
      ['GET', '/api/collaboration/status'], ['POST', '/api/collaboration/enable'],
      ['POST', '/api/agents/profiles'], ['DELETE', '/api/agents/profiles/anything']
    ]
    for (const [method, path] of forbidden) {
      await remote(controller, path, { method, ...(method === 'POST' ? { body: {} } : {}), status: 404 })
    }
    const overview = await remote(observer, '/api/agents')
    assert.equal(overview.discovered, undefined)
    for (const profile of overview.profiles) {
      assert.deepEqual(Object.keys(profile).sort(), ['id', 'name', 'runtime', 'enabled', 'allowRemote'].sort())
    }
  })

  await check('observer cannot create/stop/resume/approve; controller needs explicit allowRemote', async () => {
    localOnly = await h.profile({ allowRemote: false })
    remoteSafe = await h.profile({ allowRemote: true })
    localTask = await h.task(userId, localOnly.id)
    await h.waitTask(localTask.id, userId)
    const body = { agentId: remoteSafe.id, title: 'remote test', prompt: h.directive(), cwd: await h.dir(), requestId: h.id() }
    await remote(observer, '/api/agents/tasks', { method: 'POST', body, status: 403 })
    for (const action of ['stop', 'resume', 'approve']) {
      await remote(observer, `/api/agents/tasks/${localTask.id}/${action}`, {
        method: 'POST', body: { prompt: 'continue', requestId: h.id(), approved: true }, status: 403
      })
    }
    await remote(controller, '/api/agents/tasks', { method: 'POST', body: { ...body, agentId: localOnly.id }, status: 403 })
    await remote(controller, `/api/agents/tasks/${localTask.id}/resume`, {
      method: 'POST', body: { prompt: 'continue', requestId: h.id() }, status: 403
    })
    await remote(controller, '/api/agents/tasks', {
      method: 'POST', body: { ...body, userId: otherUser }, status: 403
    })
    await remote(controller, '/api/agents/tasks', { method: 'POST', body: { ...body, prompt: 'x'.repeat(70_000) }, status: 413 })
  })

  await check('cross-device live events, retry idempotency, user isolation and snapshot convergence', async () => {
    const observed = await h.events('/api/agents/events', { base: gateway, headers: auth(observer) })
    const controlled = await h.events('/api/agents/events', { base: gateway, headers: auth(controller) })
    const otherStream = await h.events('/api/agents/events', { base: gateway, headers: auth(otherDevice) })
    const release = join(h.root, 'remote.release')
    const cwd = await h.dir()
    const body = { agentId: remoteSafe.id, title: '<script>remote title</script>', prompt: h.directive({ release }), cwd, requestId: h.id() }
    const task = await remote(controller, '/api/agents/tasks', { method: 'POST', body, status: 201 })
    await h.waitTask(task.id, userId, (value) => value.output.includes('FIXTURE_START'))
    assert.equal((await remote(controller, '/api/agents/tasks', { method: 'POST', body, status: 201 })).id, task.id)
    assert.equal((await h.starts(cwd)).length, 1)
    for (const stream of [observed, controlled]) {
      await waitFor('cross-device output event', () => stream.values.some((event) => event.taskId === task.id && event.type === 'output'))
    }
    controlled.stop()
    await controlled.done
    assert.equal((await h.getTask(task.id, userId)).status, 'running')
    await h.release(release)
    const done = await h.waitTask(task.id, userId)
    assert.equal(done.status, 'completed')
    const completed = await waitFor('observer completed event', () => observed.values.find((event) => event.taskId === task.id && event.data?.status === 'completed'))
    const snapshot = await remote(observer, '/api/agents')
    const remoteTask = snapshot.tasks.find((item) => item.id === task.id)
    assert.deepEqual(remoteTask, done)
    assert.ok(snapshot.tasks.every((item) => item.userId === userId))
    assert.equal((await remote(controller, `/api/agents/tasks/${task.id}`)).output, done.output)
    await remote(otherDevice, `/api/agents/tasks/${task.id}?userId=${userId}`, { status: 404 })
    assert.ok(!(await remote(otherDevice, `/api/agents?userId=${userId}`)).tasks.some((item) => item.id === task.id))
    assert.ok(otherStream.values.every((event) => event.taskId !== task.id))
    const beforeOutput = observed.values.find((event) => event.taskId === task.id && event.type === 'output').seq
    const replay = await h.events('/api/agents/events', {
      base: gateway, headers: { ...auth(controller), 'Last-Event-ID': String(beforeOutput) }
    })
    await waitFor('gateway Last-Event-ID replay', () => replay.values.some((event) => event.seq === completed.seq))
    assert.ok(replay.values.every((event) => event.seq > beforeOutput))
    assert.equal(new Set(replay.values.map((event) => event.seq)).size, replay.values.length)
    for (const stream of [observed, otherStream, replay]) stream.stop()
    await Promise.all([observed.done, otherStream.done, replay.done])
  })

  await check('controller stop/resume is shared with local state and keeps attempts separate', async () => {
    const release = join(h.root, 'remote-stop.release')
    const body = { agentId: remoteSafe.id, title: 'remote stop', prompt: h.directive({ release }), cwd: await h.dir(), requestId: h.id() }
    const task = await remote(controller, '/api/agents/tasks', { method: 'POST', body, status: 201 })
    await h.waitTask(task.id, userId, (value) => value.output.includes('FIXTURE_START'))
    assert.equal((await remote(controller, `/api/agents/tasks/${task.id}/stop`, { method: 'POST', body: {} })).status, 'cancelled')
    assert.equal((await h.getTask(task.id, userId)).status, 'cancelled')
    await h.release(release)
    const resumed = await remote(controller, `/api/agents/tasks/${task.id}/resume`, {
      method: 'POST', body: { prompt: 'REMOTE_RESUME_CONTEXT', requestId: h.id() }
    })
    assert.notEqual(resumed.id, task.id)
    assert.equal(resumed.resumeOf, task.id)
    assert.equal((await h.waitTask(resumed.id, userId)).status, 'completed')
    assert.match((await h.starts(resumed.cwd)).at(-1).input, /REMOTE_RESUME_CONTEXT/)
  })

  await check('queued remote execution rechecks allowRemote after owner revokes permission', async () => {
    const profile = await h.profile({ allowRemote: true })
    const cwd = await h.dir()
    const release = join(h.root, 'remote-permission.release')
    const blocker = await h.task(userId, localOnly.id, { cwd, prompt: h.directive({ release }) })
    await h.waitTask(blocker.id, userId, (task) => task.output.includes('FIXTURE_START'))
    const queued = await remote(controller, '/api/agents/tasks', {
      method: 'POST', status: 201,
      body: { agentId: profile.id, title: 'queued remote', prompt: h.directive(), requestId: h.id(), cwd }
    })
    assert.equal(queued.status, 'queued')
    await h.request(`/api/agents/profiles/${profile.id}`, { method: 'PATCH', body: { allowRemote: false } })
    await h.release(release)
    assert.equal((await h.waitTask(blocker.id, userId)).status, 'completed')
    assert.equal((await h.waitTask(queued.id, userId)).status, 'failed')
    assert.equal((await h.starts(cwd)).length, 1)
  })

  await check('remote approval uses the same real brain loop and only controllers can release it', async () => {
    const overview = await h.request(`/api/agents?userId=${userId}`)
    const brain = overview.profiles.find((profile) => profile.runtime === 'brain')
    assert.ok(brain)
    await h.request(`/api/agents/profiles/${brain.id}`, { method: 'PATCH', body: { allowRemote: true } })
    const task = await remote(controller, '/api/agents/tasks', {
      method: 'POST', status: 201,
      body: { agentId: brain.id, title: 'remote approval', prompt: 'PIAM_APPROVAL_DOUBLE', requestId: h.id(), cwd: h.root }
    })
    const waiting = await h.waitTask(task.id, userId, (value) => value.status === 'waiting_approval')
    assert.equal(waiting.pendingApproval.command, 'printf piam-approved-1')
    await remote(observer, `/api/agents/tasks/${task.id}/approve`, {
      method: 'POST', body: { approved: true, ...h.approval(waiting) }, status: 403
    })
    await remote(controller, `/api/agents/tasks/${task.id}/approve`, { method: 'POST', body: { approved: true }, status: 400 })
    assert.deepEqual((await h.getTask(task.id, userId)).pendingApproval, waiting.pendingApproval)
    await remote(controller, `/api/agents/tasks/${task.id}/approve`, {
      method: 'POST', body: { approved: false, ...h.approval(waiting) }
    })
    const next = await h.waitTask(task.id, userId, (value) => value.status === 'waiting_approval' && value.pendingApproval?.toolCallId !== waiting.pendingApproval.toolCallId)
    assert.equal(next.pendingApproval.command, 'printf piam-approved-2')
    await remote(controller, `/api/agents/tasks/${task.id}/approve`, {
      method: 'POST', body: { approved: true, ...h.approval(waiting) }, status: 409
    })
    const unchanged = await h.getTask(task.id, userId)
    assert.equal(unchanged.status, 'waiting_approval')
    assert.deepEqual(unchanged.pendingApproval, next.pendingApproval)
    await remote(controller, `/api/agents/tasks/${task.id}/approve`, {
      method: 'POST', body: { approved: true, ...h.approval(next) }
    })
    const done = await h.waitTask(task.id, userId)
    assert.equal(done.status, 'completed')
    assert.match(done.output, /PIAM_MOCK_DONE/)
    assert.ok(h.mockRequests.some((request) => request.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('piam-approved'))))
  })

  await check('revocation closes live stream immediately and invalidates bearer without stopping tasks', async () => {
    const stream = await h.events('/api/agents/events', { base: gateway, headers: auth(observer) })
    const release = join(h.root, 'revoke.release')
    const task = await h.task(userId, remoteSafe.id, { prompt: h.directive({ release }) })
    await waitFor('revoked device is observing task', () => stream.values.some((event) => event.taskId === task.id && event.type === 'output'))
    await h.request(`/api/collaboration/devices/${observer.device.id}`, { method: 'DELETE' })
    await waitFor('revoked SSE disconnected', () => stream.closed, 3000)
    await remote(observer, '/api/agents', { status: 401 })
    await remote(observer, '/api/device', { status: 401 })
    assert.equal((await h.getTask(task.id, userId)).status, 'running')
    const status = await h.request(localStatus)
    const revoked = status.devices.find((device) => device.id === observer.device.id)
    assert.ok(revoked.revokedAt)
    assert.equal(revoked.online, false)
    await h.release(release)
    assert.equal((await h.waitTask(task.id, userId)).status, 'completed')
  })

  await check('disable disconnects stream/listener and expires outstanding pairing codes', async () => {
    const stream = await h.events('/api/agents/events', { base: gateway, headers: auth(controller) })
    const pairing = await h.request('/api/collaboration/pairing', { method: 'POST', body: { userId, role: 'observer' } })
    await h.request('/api/collaboration/disable', { method: 'POST', body: {} })
    await waitFor('disabled gateway stream closed', () => stream.closed, 3000)
    assert.equal((await h.request(localStatus)).enabled, false)
    await assert.rejects(fetch(`${gateway}/api/device`, { headers: auth(controller), signal: AbortSignal.timeout(1000) }))
    const reenabled = await h.request('/api/collaboration/enable', { method: 'POST', body: { port: 0 } })
    gateway = `http://127.0.0.1:${reenabled.port}`
    await h.request('/pair', { base: gateway, method: 'POST', body: { code: pairing.code, name: 'expired by disable' }, status: 401 })
    await remote(observer, '/api/device', { status: 401 })
    await h.restart()
    assert.equal((await h.request(localStatus)).enabled, false, 'restart must never reopen a LAN listener automatically')
  })
})
