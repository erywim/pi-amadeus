/**
 * PIAM-6：真实 HTTP → 独立 brain/SQLite → 受控 CLI/本地 SSE LLM。
 * 回放：发现/配置 → 注入与重试 → 队列/依赖/cwd → stop/恢复/移交 → 事件重放 → 崩溃重启。
 * 无桌面端前置，不读取真实 DB、认证或付费 API；finally 回收全部自有资源。
 * 用法：node scripts/e2e-agents.mjs；E2E_BRAIN_ENTRY 可指向 baseline 验证 HTTP 断言会红。
 */
import assert from 'node:assert/strict'
import { access, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { approvalCommand, runCases, waitFor } from './agent-test-harness.mjs'

await runCases('agents', async (h, check) => {
  const userId = await h.user('piam-agents-owner')
  const otherUser = await h.user('piam-agents-other')
  const query = `?userId=${encodeURIComponent(userId)}`
  let brain
  let custom

  await check('overview: default brain, maxConcurrent=3, truthful controlled-PATH discovery', async () => {
    const overview = await h.request(`/api/agents${query}`)
    assert.equal(overview.maxConcurrent, 3)
    assert.deepEqual(overview.tasks, [])
    brain = overview.profiles.find((profile) => profile.runtime === 'brain')
    assert.ok(brain?.enabled)
    assert.deepEqual(overview.discovered.map((item) => item.runtime).sort(), [
      'brain', 'claude', 'codex', 'opencode', 'pi', 'gemini', 'aider', 'goose', 'qwen', 'copilot'
    ].sort())
    const installed = overview.discovered.find((item) => item.runtime === 'opencode')
    assert.equal(installed?.installed, true)
    assert.equal(installed.path, await realpath(process.execPath))
    assert.equal(installed.version, process.version)
    for (const item of overview.discovered.filter((entry) => !['brain', 'opencode'].includes(entry.runtime))) {
      assert.equal(item.installed, false, `${item.runtime} must not use the host PATH`)
      assert.equal(item.path, null)
      assert.equal(item.version, null)
    }
  })

  await check('profiles: CRUD and invalid executable/argv rejection', async () => {
    custom = await h.profile({ name: 'Safe local fixture' })
    assert.equal(custom.command, process.execPath)
    assert.deepEqual(custom.args, [h.fixturePath])
    const changed = (await h.request(`/api/agents/profiles/${custom.id}`, {
      method: 'PATCH', body: { name: 'Safe local fixture renamed', allowRemote: false }
    })).profile
    assert.equal(changed.name, 'Safe local fixture renamed')
    const disposable = await h.profile()
    await h.request(`/api/agents/profiles/${disposable.id}`, { method: 'DELETE' })
    assert.ok(!(await h.request(`/api/agents${query}`)).profiles.some((profile) => profile.id === disposable.id))
    await h.request('/api/agents/profiles', {
      method: 'POST', status: 400, body: h.profileInput({ command: 'node; touch should-not-exist' })
    })
    await h.request('/api/agents/profiles', {
      method: 'POST', status: 400, body: h.profileInput({ promptMode: 'argument', args: ['prefix-{prompt}'] })
    })
  })

  await check('stdin literal bytes, no shell injection, requestId launches exactly once', async () => {
    const cwd = await h.dir()
    const release = join(h.root, 'idempotent.release')
    const marker = join(h.root, 'SHELL_MUST_NOT_RUN')
    const prompt = `literal 中文\n$(touch '${marker}'); \`touch '${marker}'\`; " ; & | >\n${h.directive({ release })}`
    const requestId = h.id()
    const first = await h.task(userId, custom.id, { cwd, prompt, requestId })
    await h.waitTask(first.id, userId, (task) => task.output.includes('FIXTURE_INPUT'))
    const retried = await h.task(userId, custom.id, { cwd, prompt, requestId })
    assert.equal(retried.id, first.id)
    assert.equal((await h.starts(cwd)).length, 1)
    assert.equal((await h.starts(cwd))[0].input, prompt)
    assert.equal(await access(marker).then(() => true, () => false), false)
    await h.release(release)
    const finished = await h.waitTask(first.id, userId)
    assert.equal(finished.status, 'completed')
    assert.equal((await h.starts(cwd)).length, 1)
  })

  await check('argument mode preserves one prompt argv element without shell interpretation', async () => {
    const argvProfile = await h.profile({ promptMode: 'argument', args: [h.fixturePath, '{prompt}'] })
    const prompt = 'quotes "中文"; $(false) `false` & | > <\nsecond line'
    const task = await h.task(userId, argvProfile.id, { prompt })
    assert.equal((await h.waitTask(task.id, userId)).status, 'completed')
    assert.equal((await h.starts(task.cwd))[0].input, prompt)
  })

  await check('maxConcurrent=3 queues the fourth distinct cwd, then advances only on release', async () => {
    const release = join(h.root, 'concurrency.release')
    const active = []
    for (let i = 0; i < 3; i++) {
      const task = await h.task(userId, custom.id, { prompt: h.directive({ release }) })
      active.push(await h.waitTask(task.id, userId, (value) => value.output.includes('FIXTURE_START')))
    }
    const fourth = await h.task(userId, custom.id)
    assert.equal((await h.getTask(fourth.id, userId)).status, 'queued')
    assert.equal((await h.starts(fourth.cwd)).length, 0)
    const overview = await h.request(`/api/agents${query}`)
    assert.equal(overview.tasks.filter((task) => task.status === 'running').length, 3)
    await h.release(release)
    for (const task of [...active, fourth]) assert.equal((await h.waitTask(task.id, userId)).status, 'completed')
  })

  await check('dependencies serialize and transfer completed predecessor context', async () => {
    const release = join(h.root, 'dependency.release')
    const first = await h.task(userId, custom.id, { prompt: `PREDECESSOR_CONTEXT\n${h.directive({ release })}` })
    await h.waitTask(first.id, userId, (task) => task.output.includes('FIXTURE_START'))
    const next = await h.task(userId, custom.id, { parentTaskId: first.id, prompt: 'HANDOFF_REQUEST' })
    assert.equal(next.status, 'queued')
    assert.equal((await h.starts(next.cwd)).length, 0)
    await h.release(release)
    assert.equal((await h.waitTask(first.id, userId)).status, 'completed')
    const done = await h.waitTask(next.id, userId)
    assert.equal(done.status, 'completed')
    assert.ok(done.dependsOn.includes(first.id))
    const received = (await h.starts(next.cwd))[0].input
    assert.match(received, /PREDECESSOR_CONTEXT/)
    assert.match(received, /FIXTURE_DONE/)
    assert.match(received, /HANDOFF_REQUEST/)
  })

  await check('failed predecessor cancels its dependent without launching it', async () => {
    const release = join(h.root, 'failure.release')
    const first = await h.task(userId, custom.id, { prompt: h.directive({ release, fail: true }) })
    await h.waitTask(first.id, userId, (task) => task.output.includes('FIXTURE_START'))
    const next = await h.task(userId, custom.id, { dependsOn: [first.id] })
    assert.equal(next.status, 'queued')
    await h.release(release)
    assert.equal((await h.waitTask(first.id, userId)).status, 'failed')
    assert.equal((await h.waitTask(next.id, userId)).status, 'cancelled')
    assert.equal((await h.starts(next.cwd)).length, 0)
  })

  await check('realpath cwd lock serializes aliases across users', async () => {
    const cwd = await h.dir()
    const alias = join(h.root, 'cwd-alias')
    await symlink(cwd, alias, 'dir')
    const release = join(h.root, 'cwd.release')
    const first = await h.task(userId, custom.id, { cwd, prompt: h.directive({ release }) })
    await h.waitTask(first.id, userId, (task) => task.output.includes('FIXTURE_START'))
    const next = await h.task(otherUser, custom.id, { cwd: alias })
    assert.equal((await h.getTask(next.id, otherUser)).status, 'queued')
    assert.equal((await h.starts(cwd)).length, 1)
    await h.release(release)
    await h.waitTask(first.id, userId)
    assert.equal((await h.waitTask(next.id, otherUser)).status, 'completed')
    assert.equal((await h.starts(cwd)).length, 2)
  })

  let stopped
  await check('stop stays terminal, cancels child work, retains output', async () => {
    const release = join(h.root, 'stop.release')
    stopped = await h.task(userId, custom.id, { prompt: `STOP_CONTEXT\n${h.directive({ release })}` })
    await h.waitTask(stopped.id, userId, (task) => task.output.includes('FIXTURE_START'))
    const dependent = await h.task(userId, custom.id, { dependsOn: [stopped.id] })
    const cancelled = await h.action(stopped.id, 'stop', { userId })
    assert.equal(cancelled.status, 'cancelled')
    assert.match(cancelled.output, /FIXTURE_START/)
    assert.equal((await h.waitTask(dependent.id, userId)).status, 'cancelled')
    assert.equal((await h.starts(dependent.cwd)).length, 0)
    const pid = (await h.starts(stopped.cwd))[0].pid
    await waitFor('stopped fixture process exited', () => {
      try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
    })
    await h.release(release)
    assert.equal((await h.action(stopped.id, 'stop', { userId })).status, 'cancelled')
    assert.equal((await h.getTask(stopped.id, userId)).status, 'cancelled')
  })

  await check('resume creates separate attempt/session and passes prior context', async () => {
    const resumed = await h.action(stopped.id, 'resume', { userId, prompt: 'RESUME_NEW_REQUEST', requestId: h.id() })
    assert.notEqual(resumed.id, stopped.id)
    assert.notEqual(resumed.sessionId, stopped.sessionId)
    assert.equal(resumed.resumeOf, stopped.id)
    const done = await h.waitTask(resumed.id, userId)
    assert.equal(done.status, 'completed')
    const input = (await h.starts(done.cwd)).at(-1).input
    assert.match(input, /STOP_CONTEXT/)
    assert.match(input, /FIXTURE_START/)
    assert.match(input, /RESUME_NEW_REQUEST/)
    assert.equal((await h.getTask(stopped.id, userId)).status, 'cancelled')
  })

  await check('invalid input, cross-user reads/actions/dependencies and local web origins rejected', async () => {
    const body = { userId, agentId: custom.id, title: 'invalid', prompt: 'test', cwd: h.root, requestId: h.id() }
    for (const patch of [{ prompt: '' }, { requestId: '' }, { cwd: join(h.root, 'missing') }, { agentId: 'not-found' }]) {
      await h.request('/api/agents/tasks', { method: 'POST', body: { ...body, ...patch }, status: [400, 404] })
    }
    await h.request(`/api/agents/tasks/${stopped.id}?userId=${otherUser}`, { status: 404 })
    await h.request(`/api/agents/tasks/${stopped.id}/stop`, { method: 'POST', body: { userId: otherUser }, status: 404 })
    await h.request(`/api/agents/tasks/${stopped.id}/resume`, { method: 'POST', body: { userId: otherUser, requestId: h.id() }, status: 404 })
    await h.request('/api/agents/tasks', { method: 'POST', body: { ...body, userId: otherUser, dependsOn: [stopped.id] }, status: [400, 404] })
    for (const origin of ['null', 'https://untrusted.example']) {
      // HTTP boundary rejects hostile browser origins before the Agent route's 400 validation.
      await h.request(`/api/agents${query}`, { headers: { Origin: origin }, status: [400, 403] })
    }
    const otherOverview = await h.request(`/api/agents?userId=${otherUser}`)
    assert.ok(otherOverview.tasks.every((task) => task.userId === otherUser))
  })

  await check('position persists with optimistic revision; stale write returns 409', async () => {
    const original = await h.getTask(stopped.id, userId)
    const moved = (await h.request(`/api/agents/tasks/${stopped.id}/position`, {
      method: 'PATCH', body: { userId, revision: original.revision, position: { x: 123, y: -45 } }
    })).task
    assert.deepEqual(moved.position, { x: 123, y: -45 })
    assert.ok(moved.revision > original.revision)
    await h.request(`/api/agents/tasks/${stopped.id}/position`, {
      method: 'PATCH', body: { userId, revision: original.revision, position: { x: 999, y: 999 } }, status: 409
    })
    assert.deepEqual((await h.getTask(stopped.id, userId)).position, moved.position)
  })

  await check('default brain uses real local LLM loop; approval is owner scoped and executes only after approval', async () => {
    const plain = await h.task(userId, brain.id, { prompt: 'PIAM_SIMPLE_BRAIN' })
    const plainDone = await h.waitTask(plain.id, userId)
    assert.equal(plainDone.status, 'completed')
    assert.match(plainDone.output, /PIAM_MOCK_DONE/)
    const approval = await h.task(userId, brain.id, { prompt: 'PIAM_APPROVAL' })
    const waiting = await h.waitTask(approval.id, userId, (task) => task.status === 'waiting_approval')
    assert.ok(waiting.pendingApproval?.toolCallId)
    assert.equal(waiting.pendingApproval.command, 'printf piam-approved')
    await h.request(`/api/agents/tasks/${approval.id}/approve`, {
      method: 'POST', body: { userId: otherUser, approved: true, ...h.approval(waiting) }, status: 404
    })
    await h.request(`/api/agents/tasks/${approval.id}/approve`, {
      method: 'POST', body: { userId, approved: true }, status: 400
    })
    assert.deepEqual((await h.getTask(approval.id, userId)).pendingApproval, waiting.pendingApproval)
    await h.action(approval.id, 'approve', { userId, approved: true, ...h.approval(waiting) })
    const approved = await h.waitTask(approval.id, userId)
    assert.equal(approved.status, 'completed')
    assert.match(approved.output, /PIAM_MOCK_DONE/)
    const toolRequest = h.mockRequests.find((request) => request.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('piam-approved')))
    assert.ok(toolRequest, 'real bash result must return through the real agent loop')
  })

  await check('approval shows exact 16KiB UTF-8 command; larger commands cannot hide or execute prefixes', async () => {
    const boundary = approvalCommand('boundary')
    assert.equal(Buffer.byteLength(boundary), 16 * 1024)
    assert.ok(boundary.length < 16 * 1024, 'boundary must exercise multibyte byte length, not JS characters')
    const allowed = await h.task(userId, brain.id, { prompt: 'PIAM_APPROVAL_BOUNDARY' })
    const waiting = await h.waitTask(allowed.id, userId, (task) => task.status === 'waiting_approval')
    assert.equal(waiting.pendingApproval.command, boundary, 'approval must show the entire executable command, including prefix')
    await h.action(allowed.id, 'approve', { userId, approved: true, ...h.approval(waiting) })
    assert.equal((await h.waitTask(allowed.id, userId)).status, 'completed')
    assert.ok(h.mockRequests.some((request) => request.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('PIAM_BOUNDARY_OK'))))
    const stream = await h.events(`/api/agents/events${query}`)
    await waitFor('command limit event observer', () => stream.values.some((event) => event.data?.resync))
    for (const [prompt, kind] of [['PIAM_APPROVAL_LONG', 'long'], ['PIAM_APPROVAL_OVER_BOUNDARY', 'over-boundary']]) {
      const command = approvalCommand(kind)
      assert.ok(Buffer.byteLength(command) > 16 * 1024)
      if (kind === 'over-boundary') assert.equal(Buffer.byteLength(command), 16 * 1024 + 1)
      const task = await h.task(userId, brain.id, { prompt })
      const done = await h.waitTask(task.id, userId)
      assert.equal(done.status, 'completed')
      await waitFor('oversized command terminal event', () => stream.values.some((event) => event.taskId === task.id && event.data?.status === 'completed'))
      const events = stream.values.filter((event) => event.taskId === task.id)
      assert.ok(!events.some((event) => event.data?.status === 'waiting_approval' || event.data?.pendingApproval), 'oversized command must never create an approval')
      const toolEnd = events.find((event) => event.type === 'tool' && event.data?.type === 'tool_end')
      assert.ok(toolEnd?.data.isError)
      assert.equal(toolEnd.data.details?.deniedReason, 'blocked')
      assert.doesNotMatch(toolEnd.data.result, /PIAM_HIDDEN_PREFIX|PIAM_BOUNDARY_OK/)
      assert.equal(done.pendingApproval, null)
    }
    stream.stop()
    await stream.done
  })

  await check('approval A replay cannot authorize later command B in the same task', async () => {
    const task = await h.task(userId, brain.id, { prompt: 'PIAM_APPROVAL_DOUBLE' })
    const first = await h.waitTask(task.id, userId, (value) => value.status === 'waiting_approval')
    assert.equal(first.pendingApproval.command, 'printf piam-approved-1')
    // A 拒绝后由真实工具循环发起 B；用事件身份复现迟到点击，不靠 sleep 撞超时窗口。
    await h.action(task.id, 'approve', { userId, approved: false, ...h.approval(first) })
    const second = await h.waitTask(task.id, userId, (value) => value.status === 'waiting_approval' && value.pendingApproval?.toolCallId !== first.pendingApproval.toolCallId)
    assert.equal(second.pendingApproval.command, 'printf piam-approved-2')
    await h.request(`/api/agents/tasks/${task.id}/approve`, {
      method: 'POST', body: { userId, approved: true, ...h.approval(first) }, status: 409
    })
    const unchanged = await h.getTask(task.id, userId)
    assert.equal(unchanged.status, 'waiting_approval')
    assert.deepEqual(unchanged.pendingApproval, second.pendingApproval)
    await h.action(task.id, 'approve', { userId, approved: true, ...h.approval(second) })
    assert.equal((await h.waitTask(task.id, userId)).status, 'completed')
  })

  await check('event replay, user scoping, snapshot convergence; observer disconnect never stops work', async () => {
    const stream = await h.events(`/api/agents/events${query}`)
    await waitFor('initial task snapshot', () => stream.values.some((event) => event.data?.resync))
    const release = join(h.root, 'event.release')
    const task = await h.task(userId, custom.id, { prompt: h.directive({ release }) })
    await h.waitTask(task.id, userId, (value) => value.output.includes('FIXTURE_START'))
    await waitFor('live output event', () => stream.values.find((event) => event.taskId === task.id && event.type === 'output'))
    const cursor = Math.max(...stream.values.map((event) => event.seq))
    stream.stop()
    await stream.done
    assert.equal((await h.getTask(task.id, userId)).status, 'running')
    await h.release(release)
    const done = await h.waitTask(task.id, userId)
    const replay = await h.events(`/api/agents/events${query}&after=${cursor}`, { headers: { 'Last-Event-ID': String(cursor) } })
    await waitFor('terminal event replay', () => replay.values.some((event) => event.taskId === task.id && event.data?.status === 'completed'))
    assert.ok(replay.values.every((event) => event.seq > cursor))
    assert.equal(new Set(replay.values.map((event) => event.seq)).size, replay.values.length)
    const otherStream = await h.events(`/api/agents/events?userId=${otherUser}`)
    await waitFor('other user snapshot', () => otherStream.values.some((event) => event.data?.resync))
    const snapshot = otherStream.values.find((event) => event.data?.resync)
    assert.ok(snapshot.data.tasks.every((item) => item.userId === otherUser))
    assert.ok(!snapshot.data.tasks.some((item) => item.id === task.id))
    const fresh = await h.events(`/api/agents/events${query}`)
    await waitFor('reconnected snapshot convergence', () => fresh.values.some((event) => event.data?.tasks?.some((item) => item.id === task.id && item.output === done.output && item.status === done.status)))
    for (const connection of [replay, otherStream, fresh]) connection.stop()
    await Promise.all([replay.done, otherStream.done, fresh.done])
  })

  await check('crash restart interrupts active/queued attempts, preserves output, never auto-runs', async () => {
    const cwd = await h.dir()
    const release = join(h.root, 'restart.release')
    const active = await h.task(userId, custom.id, { cwd, prompt: h.directive({ release }) })
    const running = await h.waitTask(active.id, userId, (task) => task.output.includes('FIXTURE_START'))
    const queued = await h.task(userId, custom.id, { cwd })
    assert.equal(queued.status, 'queued')
    await h.restart({ crash: true })
    const recovered = await h.getTask(active.id, userId)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(recovered.output, running.output)
    assert.equal((await h.getTask(queued.id, userId)).status, 'interrupted')
    assert.equal((await h.starts(cwd)).length, 1)
    await h.release(release)
    const unrelated = await h.task(userId, custom.id)
    assert.equal((await h.waitTask(unrelated.id, userId)).status, 'completed')
    assert.equal((await h.getTask(active.id, userId)).status, 'interrupted')
    assert.equal((await h.starts(cwd)).length, 1)
    assert.deepEqual((await h.getTask(stopped.id, userId)).position, { x: 123, y: -45 })
    const pid = (await h.starts(cwd))[0].pid
    await waitFor('crashed brain fixture orphan exits', () => {
      try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
    })
  })
})
