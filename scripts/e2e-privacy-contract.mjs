/**
 * 已审查隐私契约回归（本次修复请求）：
 *  1. 列表隐藏的敏感/内部路径 → 直接 file/diff 与符号链接也必须拒绝。
 *  2. MCP 安装 → 列表 → 停用/启用 → 重连 → custom，响应不能带回 env 凭证。
 *  3. 长 custom id + 同前缀工具名 → 名称有界、稳定、不冲突，仍调用原工具。
 *  4. 已连接进程在调用中退出 → 请求失败、状态/工具清除 → 相同配置 sync 恢复。
 *
 * node scripts/e2e-privacy-contract.mjs
 * 不启动 brain/Electron，不使用网络或用户配置；Hono 请求在进程内执行。
 * HOME、Git 配置、工作区、SQLite 和所有 stdio mock 都隔离到本次临时目录，退出前清理。
 */
import assert from 'node:assert/strict'
import childProcess, { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'

const dir = await realpath(await mkdtemp(join(tmpdir(), 'amadeus-privacy-')))
const root = join(dir, 'workspace')
const children = []
const managers = new Set()
let db

// mock 也不能继承用户凭证；只保留查找本地 Git/Node 所需的系统环境。
const originalEnv = { ...process.env }
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'SystemRoot', 'WINDIR', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key]
}
Object.assign(process.env, {
  HOME: join(dir, 'home'),
  USERPROFILE: join(dir, 'home'),
  XDG_CONFIG_HOME: join(dir, 'home'),
  XDG_DATA_HOME: join(dir, 'home'),
  XDG_CACHE_HOME: join(dir, 'home'),
  TMPDIR: dir,
  TMP: dir,
  TEMP: dir,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
  GIT_TEMPLATE_DIR: join(dir, 'templates'),
  GIT_TERMINAL_PROMPT: '0',
  DB_PATH: join(dir, 'privacy.db'),
  WORKSPACE_DIR: root,
  BASH_TOOL_CWD: root
})

const spawn = childProcess.spawn
mock.method(childProcess, 'spawn', (command, args, options) => {
  assert.equal(command, process.execPath, '只允许启动本地 Node mock，不运行 npx/外部服务')
  const child = spawn(command, args, { ...options, cwd: dir })
  const closed = new Promise((resolve) => child.once('close', resolve))
  children.push({ child, closed })
  return child
})
syncBuiltinESMExports()

after(async () => {
  // 测试结束 → 关闭本次创建的运行时，再等每个真实子进程退出，不能遗留后台任务。
  for (const manager of managers) manager.closeAll()
  for (const { child, closed } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
  await db?.close()
  mock.restoreAll()
  syncBuiltinESMExports()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(dir, { recursive: true, force: true })
})

await Promise.all(['workspace', 'home', 'skills', 'templates'].map((path) => mkdir(join(dir, path))))
await writeFile(join(dir, 'gitconfig'), '')

const { workspaceRoutes } = await import('../services/brain/src/routes/workspace.ts')
const { pluginRoutes } = await import('../services/brain/src/routes/plugins.ts')
const { createDb } = await import('../services/brain/src/db.ts')
const { findCatalogEntry } = await import('../services/brain/src/plugins/catalog.ts')
const { mcpSpecsOf } = await import('../services/brain/src/plugins/registry.ts')
const { McpManager, agentToolName, mcpManager } = await import('../services/brain/src/mcp/manager.ts')
managers.add(mcpManager)

const SECRET = 'privacy-fixture-not-a-real-token'
const cfg = { workspace: { root }, skills: { dir: join(dir, 'skills') } }

// 纯 stdio 回显服务：无网络、无文件读写；exit_pending 仅结束它自己的测试进程。
const MCP_MOCK = String.raw`
import { createInterface } from 'node:readline'
const names = JSON.parse(process.env.PRIVACY_MOCK_TOOLS ?? '["echo","exit_pending"]')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (method === 'initialize') {
    if (process.env.PRIVACY_EXIT_PHASE === 'initialize') process.exit(23)
    reply(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'privacy-mock', version: '1' } })
  } else if (method === 'tools/list') {
    if (process.env.PRIVACY_EXIT_PHASE === 'list') process.exit(23)
    reply(id, { tools: names.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })) })
  } else if (method === 'tools/call') {
    if (params.name === 'exit_pending') process.exit(23)
    reply(id, { content: [{ type: 'text', text: JSON.stringify({
      tool: params.name, args: params.arguments, pid: process.pid,
      tokenLength: (process.env.PRIVACY_TEST_TOKEN ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? '').length
    }) }] })
  }
})
`
const mockArgs = ['--input-type=module', '-e', MCP_MOCK]
const specOf = (id, env = {}) => ({ id, name: id, command: process.execPath, args: mockArgs, env })
const latestChild = () => children.at(-1)
const decodeTool = (result) => JSON.parse(result.content[0].text)

async function request(app, path, method = 'GET', body) {
  const response = await app.request(path, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  })
  assert.equal(response.status, 200, `${method} ${path}`)
  return response.json()
}

test('workspace: sensitive/internal 过滤覆盖直接读取与 diff', { timeout: 10_000 }, async (t) => {
  await mkdir(join(root, '.multica'))
  await mkdir(join(root, 'nested'))
  const sensitive = ['.env', '.env.local', 'nested/.env.prod', 'id_rsa', 'cert.pem', '.multica/context.json', '.env.deleted']
  for (const path of ['public.txt', 'deleted.txt', ...sensitive]) {
    await writeFile(join(root, path), `${path}: original ${sensitive.includes(path) ? SECRET : 'ordinary'}\n`)
  }
  execFileSync('git', ['init', '--quiet', root])
  // 只暂存临时仓库，不创建任何提交；同时验证无 HEAD 时的 diff 分支。
  execFileSync('git', ['-C', root, 'add', '--force', '.'])
  await writeFile(join(root, 'public.txt'), 'ordinary changed\n')
  await writeFile(join(root, '.env'), `${SECRET}: changed\n`)
  await writeFile(join(root, 'new.txt'), 'ordinary untracked\n')
  await writeFile(join(root, '.env.untracked'), SECRET)
  await rm(join(root, '.env.deleted'))
  await rm(join(root, 'deleted.txt'))
  await writeFile(join(dir, 'outside.txt'), SECRET)
  for (const [alias, target] of [
    ['alias-env.txt', '.env'],
    ['alias-chain.txt', 'alias-env.txt'],
    ['alias-internal.txt', '.multica/context.json'],
    ['alias-internal-dir', '.multica'],
    ['alias-outside.txt', join(dir, 'outside.txt')],
    ['alias-ordinary.txt', 'public.txt'],
    ['.multica/public-link.txt', '../public.txt'],
    ['.env.link', 'public.txt']
  ]) await symlink(target, join(root, alias))

  const app = workspaceRoutes(cfg)
  for (const path of [
    ...sensitive, '.env.untracked', '.env.link', '.multica/public-link.txt',
    '././.multica/context.json', '.\\.multica\\context.json',
    'alias-env.txt', 'alias-chain.txt', 'alias-internal.txt', 'alias-internal-dir/context.json',
    'alias-outside.txt', '../outside.txt', join(dir, 'outside.txt')
  ]) {
    for (const endpoint of ['file', 'diff']) {
      await t.test(`${endpoint} 拒绝 ${path}`, async () => {
        const response = await app.request(`/workspace/${endpoint}?path=${encodeURIComponent(path)}`)
        assert.ok([400, 404].includes(response.status), `应拒绝路径，实际 HTTP ${response.status}`)
        assert.ok(!(await response.text()).includes(SECRET), '错误响应也不能带出正文')
      })
    }
  }
  await t.test('普通文件/未跟踪文件/普通符号链接仍可读，普通删除仍可 diff', async () => {
    for (const path of ['public.txt', 'new.txt', 'alias-ordinary.txt']) {
      const file = await request(app, `/workspace/file?path=${path}`)
      assert.match(file.content, /ordinary/)
      const diff = await request(app, `/workspace/diff?path=${path}`)
      assert.match(diff.diff, /ordinary/)
    }
    assert.match((await request(app, '/workspace/diff?path=deleted.txt')).diff, /ordinary/)
  })
  await t.test('目录与 Git pathspec 不能展开读取敏感 diff', async () => {
    for (const path of ['.', '.multica', '*', ':(glob)**', ':(top)*']) {
      const response = await app.request(`/workspace/diff?path=${encodeURIComponent(path)}`)
      assert.ok([400, 404].includes(response.status), `diff 只能接收单文件路径：${path}`)
      assert.ok(!(await response.text()).includes(SECRET))
    }
  })
  await t.test('文件树/搜索/Git 列表的现有过滤不回退', async () => {
    const tree = await request(app, '/workspace/tree')
    const search = await request(app, '/workspace/search?q=.env')
    const git = await request(app, '/workspace/git')
    for (const path of sensitive) {
      assert.ok(!tree.entries.some((entry) => entry.path === path))
      assert.ok(!search.hits.some((entry) => entry.path === path))
      assert.ok(!git.files.some((entry) => entry.path === path))
    }
  })
})

test('plugins: 所有 MCP 响应只返回 env 键名与配置状态', { timeout: 10_000 }, async (t) => {
  db = createDb({ path: join(dir, 'privacy.db') })
  await db.init()
  const app = pluginRoutes(cfg, db)
  const entry = findCatalogEntry('mcp-github')
  const preset = entry.mcp
  entry.mcp = { ...preset, command: process.execPath, args: mockArgs }
  const assertPrivate = (plugin, env) => {
    assert.ok(!JSON.stringify(plugin).includes(SECRET), 'API 响应泄漏了 config.env 凭证')
    assert.deepEqual(plugin.config.env, env)
    assert.deepEqual(Object.keys(plugin.config.env), Object.keys(env), '兼容详情 UI 的 Object.keys(env)')
  }
  try {
    const installed = await request(app, '/plugins/mcp-github/install', 'POST', {
      fields: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET }
    })
    await t.test('安装响应', () => assertPrivate(installed.plugin, { GITHUB_PERSONAL_ACCESS_TOKEN: true }))
    const listed = await request(app, '/plugins')
    await t.test('列表响应', () => {
      assert.ok(!JSON.stringify(listed).includes(SECRET))
      assertPrivate(listed.installed.find((p) => p.id === 'mcp-github'), { GITHUB_PERSONAL_ACCESS_TOKEN: true })
    })
    for (const enabled of [false, true]) {
      const result = await request(app, '/plugins/mcp-github/enabled', 'PUT', { enabled })
      await t.test(`${enabled ? '启用' : '停用'}响应`, () => {
        assert.equal(result.plugin.enabled, enabled)
        assertPrivate(result.plugin, { GITHUB_PERSONAL_ACCESS_TOKEN: true })
      })
    }
    const reconnected = await request(app, '/plugins/mcp-github/reconnect', 'POST')
    await t.test('重连响应', () => assertPrivate(reconnected.plugin, { GITHUB_PERSONAL_ACCESS_TOKEN: true }))
    const custom = await request(app, '/mcp/custom', 'POST', {
      ...specOf('unused'), name: 'privacy custom', env: { PRIVACY_TEST_TOKEN: SECRET }
    })
    await t.test('custom 响应', () => assertPrivate(custom.plugin, { PRIVACY_TEST_TOKEN: true }))
    await t.test('不修改落库凭证，运行时仍拿到原值', async () => {
      assert.equal((await db.getPlugin(custom.plugin.id)).config.env.PRIVACY_TEST_TOKEN, SECRET)
      assert.equal((await mcpSpecsOf(db)).find((spec) => spec.id === custom.plugin.id).env.PRIVACY_TEST_TOKEN, SECRET)
      const echo = mcpManager.listAgentTools().find((tool) => tool.label === 'privacy custom · echo')
      assert.equal(decodeTool(await echo.execute('env-check', {})).tokenLength, SECRET.length)
    })
    await db.upsertPlugin({
      id: 'empty-env', kind: 'mcp', name: 'empty env', enabled: false,
      config: { command: process.execPath, args: [], env: { EMPTY: '', TOKEN: SECRET } }
    })
    await db.upsertPlugin({ id: 'no-env', kind: 'mcp', name: 'no env', enabled: false, config: {} })
    const empty = await request(app, '/plugins')
    await t.test('空值/缺省 env 与 disabled 状态', () => {
      assertPrivate(empty.installed.find((p) => p.id === 'empty-env'), { EMPTY: false, TOKEN: true })
      assertPrivate(empty.installed.find((p) => p.id === 'no-env'), {})
      assert.equal(empty.installed.find((p) => p.id === 'empty-env').status.state, 'disabled')
    })
  } finally {
    entry.mcp = preset
    mcpManager.closeAll()
  }
})

test('names: custom 长前缀/清洗/边界不冲突，工具仍正确路由', { timeout: 10_000 }, async () => {
  const id = 'mcp-custom-11111111-1111-4111-8111-111111111111'
  const long = `same_prefix_${'x'.repeat(80)}`
  const pairs = [
    [id, `${long}a`], [id, `${long}b`],
    [id, 'a.b'], [id, 'a/b'], [id, 'a_b'],
    ['a_b', 'c'], ['a', 'b_c'],
    [id, 'exactly64___a'], [id, 'exactly64___b']
  ]
  const names = pairs.map(([server, tool]) => agentToolName(server, tool))
  assert.equal(new Set(names).size, pairs.length, '不同 (serverId, toolName) 不能因截断/清洗而重名')
  for (let index = 0; index < names.length; index += 1) {
    assert.ok(names[index].length <= 64)
    assert.match(names[index], /^[a-zA-Z0-9_-]+$/)
    assert.equal(names[index], agentToolName(...pairs[index]), '名称必须稳定')
  }
  const manager = new McpManager()
  managers.add(manager)
  try {
    await manager.sync([specOf(id, { PRIVACY_MOCK_TOOLS: JSON.stringify(pairs.filter(([server]) => server === id).map(([, tool]) => tool)) })])
    const tools = manager.listAgentTools()
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length)
    for (const tool of tools) {
      const result = decodeTool(await tool.execute('route-check', { marker: tool.name }))
      assert.equal(tool.name, agentToolName(id, result.tool))
      assert.equal(result.args.marker, tool.name)
    }
  } finally {
    manager.closeAll()
  }
})

test('lifecycle: 退出清除状态/工具，相同配置 sync 可重连', { timeout: 10_000 }, async (t) => {
  const manager = new McpManager()
  managers.add(manager)
  const spec = specOf('privacy-lifecycle')
  try {
    await manager.sync([spec])
    const first = latestChild()
    assert.equal(manager.statusOf(spec.id).state, 'connected')
    assert.equal(manager.connectedServerCount(), 1)
    const tools = manager.listAgentTools()
    const exit = tools.find((tool) => tool.label.endsWith(' · exit_pending'))
    await assert.rejects(exit.execute('pending-exit', {}), /退出/)
    // 等真实 close 事件，不用固定 sleep 猜测管理器何时观察到退出。
    await first.closed
    await t.test('进程退出后不再 connected', () => assert.equal(manager.statusOf(spec.id).state, 'error'))
    await t.test('计数和所有可调用工具立即移除', () => {
      assert.equal(manager.connectedServerCount(), 0)
      assert.deepEqual(manager.listAgentTools(), [])
      assert.deepEqual(manager.statusOf(spec.id).tools, [])
    })
    await t.test('同配置 sync 创建新进程并恢复可用工具', async () => {
      await manager.sync([spec])
      assert.notEqual(latestChild().child.pid, first.child.pid, '不能复用已经退出的客户端')
      assert.equal(manager.statusOf(spec.id).state, 'connected')
      assert.equal(manager.connectedServerCount(), 1)
      const echo = manager.listAgentTools().find((tool) => tool.label.endsWith(' · echo'))
      assert.equal(decodeTool(await echo.execute('reconnected', {})).pid, latestChild().child.pid)
    })
    for (const phase of ['initialize', 'list']) {
      await t.test(`${phase} 期间退出也不残留工具`, async () => {
        const failed = specOf(`privacy-${phase}`, { PRIVACY_EXIT_PHASE: phase })
        await manager.sync([failed])
        assert.equal(manager.statusOf(failed.id).state, 'error')
        assert.equal(manager.connectedServerCount(), 0)
        assert.deepEqual(manager.listAgentTools(), [])
      })
    }
  } finally {
    manager.closeAll()
  }
})
