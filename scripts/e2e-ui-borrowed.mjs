/**
 * 借鉴类 UI/效率能力 E2E（CDP 驱动真实 Electron + 真实 brain）：
 *  1. 命令面板：⌘K 打开、搜索页面/会话/消息、Esc 关闭
 *  2. 只读工作区：真实文件树、文件正文、Git 变更与 diff；路径越界被拒绝；敏感文件不出现在树里
 *  3. 斜杠内置命令与 @ 工作区文件引用
 *  4. 流式排队：生成中继续发送 → 排队 → 回合结束后自动发出（真实 LLM 可用时）
 *  5. 上下文估算读数
 *  6. 消息分支树：编辑产生分支 → 树里显示新旧分支 → 点旧分支切回（真实 LLM 可用时）
 *  7. 导出 Markdown（真实下载文件，内容来自落库消息）
 *  8. 完成通知开关存在
 *
 * 前置：brain（默认 3002）与桌面端 dev（CDP 默认 9222，可用 CDP_HTTP 覆盖）已启动。
 * 测试自建会话，结束统一清理；下载落到临时目录；不写入用户真实数据目录。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'
const DOWNLOAD_DIR = process.env.E2E_DOWNLOAD_DIR ?? '/tmp/amadeus-e2e-borrowed-downloads'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP  ${name} — ${reason}`)
}

async function api(path, options) {
  const res = await fetch(`${BRAIN}${path}`, options)
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text }
  }
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
const target = targets.find((item) => item.type === 'page')
if (!target) {
  console.error('未找到 Electron 页面目标。确认桌面端 dev 已启动。')
  process.exit(1)
}
const cdp = await new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onopen = () =>
    resolve({
      call(method, params = {}) {
        return new Promise((resP, rej) => {
          const callId = ++id
          pending.set(callId, { resP, rej })
          ws.send(JSON.stringify({ id: callId, method, params }))
        })
      },
      close: () => ws.close()
    })
  ws.onerror = (error) => reject(new Error(`CDP 失败: ${error.message}`))
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resP, rej } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) rej(new Error(message.error.message))
      else resP(message.result)
    }
  }
})

async function evalJs(expression) {
  // 页面导航 / HMR 期间上下文可能被回收；表达式尚未真正执行时重试是安全的
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await cdp.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (result.exceptionDetails) {
        throw new Error(
          `页面脚本异常: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`
        )
      }
      return result.result.value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transient = /Promise was collected|Cannot find context|Execution context was destroyed|Target closed/i.test(
        message
      )
      if (attempt < 2 && transient) {
        await sleep(200)
        continue
      }
      throw error
    }
  }
}
async function waitFor(expression, timeoutMs = 30_000, label = expression) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(expression)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await sleep(250)
  }
}
const setInput = (selector, value) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
const click = (selector, index = 0) =>
  `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}]
    if (!el) return false
    el.click()
    return true
  })()`

let prevActiveSessionId = null
const createdSessionIds = []

async function cleanup() {
  for (const id of createdSessionIds) {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }
  await evalJs(`(() => {
    const ids = ${JSON.stringify(createdSessionIds)}
    if (ids.length === 0) return true
    const store = window.__amadeus.sessionStore
    const state = store.getState()
    const messages = { ...state.messages }
    for (const id of ids) delete messages[id]
    const sessions = state.sessions.filter((item) => !ids.includes(item.id))
    const activeGone = ids.includes(state.activeSessionId)
    store.setState({ sessions, messages, ...(activeGone ? { activeSessionId: null } : {}) })
    const prev = ${JSON.stringify(prevActiveSessionId)}
    if (activeGone && prev && sessions.some((item) => item.id === prev)) {
      store.getState().selectSession(prev)
    }
    return true
  })()`).catch(() => {})
  rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
}

let cleaned = false
async function cleanupOnce() {
  if (cleaned) return
  cleaned = true
  await cleanup()
}

try {
  await evalJs(`location.pathname === '/text' ? true : (location.href = '/text', true)`)
  await sleep(1200)
  await waitFor(
    `window.__amadeus?.sessionStore.getState().initialized && !!window.__amadeus.sessionStore.getState().userId`,
    20_000,
    'sessionStore init'
  )
  prevActiveSessionId = await evalJs(
    `window.__amadeus.sessionStore.getState().activeSessionId ?? null`
  )
  const sid = await evalJs(`window.__amadeus.sessionStore.getState().createSession()`)
  createdSessionIds.push(sid)

  // ---------- 1. 命令面板 ----------
  await evalJs(`window.__amadeus.uiStore.getState().setCommandPaletteOpen(false); true`)
  await evalJs(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); true`
  )
  await waitFor(`!!document.querySelector('[data-testid="palette-input"]')`, 5000, '命令面板')
  const initialPaletteItems = await evalJs(
    `document.querySelectorAll('[data-testid="palette-item"]').length`
  )
  report('命令面板：⌘K 打开并列出动作/页面', initialPaletteItems >= 8, `items=${initialPaletteItems}`)
  await evalJs(setInput('[data-testid="palette-input"]', '数据'))
  await waitFor(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].some((el) => el.textContent.includes('数据'))`,
    5000,
    '命令面板搜索页面'
  )
  report('命令面板：输入即过滤页面', true)
  await evalJs(
    `document.querySelector('[data-testid="palette-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`
  )
  await waitFor(`!document.querySelector('[data-testid="palette-input"]')`, 5000, '命令面板关闭')
  report('命令面板：Esc 关闭', true)

  // ---------- 2. 只读工作区 ----------
  await evalJs(click('[data-testid="panel-tab-workspace"]'))
  await waitFor(`!!document.querySelector('[data-testid="workspace-view"]')`, 10_000, '工作区面板')
  await waitFor(
    `document.querySelectorAll('[data-testid="workspace-file"]').length > 0`,
    15_000,
    '工作区文件树'
  )
  const fileCount = await evalJs(
    `document.querySelectorAll('[data-testid="workspace-file"]').length`
  )
  report('工作区：文件树来自真实目录', fileCount > 5, `files=${fileCount}`)
  // 回归：npm workspace 脚本的 cwd 是 services/brain，工作区默认值曾经跟着它走，
  // 导致文件树指向大脑包目录（根 package.json 是 @pi-amadeus/brain）。
  // 工作区根必须是仓库根：根 package.json 的 name 是 pi-amadeus。
  const rootInfo = await (await fetch(`${BRAIN}/api/workspace/info`)).json()
  const rootPkg = await (
    await fetch(`${BRAIN}/api/workspace/file?path=package.json`)
  ).json()
  report(
    '工作区：根目录是仓库根而不是 services/brain',
    rootInfo.isRepo === true &&
      rootInfo.name !== 'brain' &&
      typeof rootPkg.content === 'string' &&
      rootPkg.content.includes('"name": "pi-amadeus"'),
    `root=${rootInfo.name} pkg=${(rootPkg.content ?? '').slice(0, 40).replace(/\n/g, ' ')}`
  )

  const packagePath = await evalJs(
    `[...document.querySelectorAll('[data-testid="workspace-file"]')].find((el) => el.dataset.path === 'package.json')?.dataset.path ?? null`
  )
  if (packagePath) {
    await evalJs(
      `document.querySelector('[data-testid="workspace-file"][data-path="package.json"]').click(); true`
    )
    await waitFor(`!!document.querySelector('[role="dialog"] pre')`, 8000, '文件正文弹窗')
    const preview = await evalJs(`document.querySelector('[role="dialog"] pre')?.textContent ?? ''`)
    report('工作区：文件正文可读', preview.includes('"name": "pi-amadeus"'), `${preview.length} chars`)
    await evalJs(`[...document.querySelectorAll('[role="dialog"] button')].at(-1)?.click(); true`)
    await sleep(300)
  } else {
    skip('工作区：文件正文可读', '工作区根目录没有 package.json')
  }

  // Git：有变更就打开 diff，没有变更就确认干净状态（两种都是真实结果）
  const gitStatus = await api('/api/workspace/git')
  report(
    '工作区：Git 状态接口返回真实仓库',
    gitStatus.status === 200 && gitStatus.body?.isRepo === true && typeof gitStatus.body.branch === 'string',
    `branch=${gitStatus.body?.branch ?? ''}`
  )
  await evalJs(click('[data-testid="workspace-tab-changes"]'))
  await sleep(400)
  const changeCount = await evalJs(
    `document.querySelectorAll('[data-testid="workspace-change"]').length`
  )
  if (changeCount > 0) {
    await evalJs(click('[data-testid="workspace-change"]'))
    await waitFor(
      `document.querySelector('[role="dialog"]')?.textContent?.includes('diff --git')`,
      8000,
      'diff 弹窗'
    )
    const diffText = await evalJs(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
    report('工作区：变更文件与 diff 可读', diffText.includes('diff --git'), `${changeCount} changes`)
    await evalJs(`[...document.querySelectorAll('[role="dialog"] button')].at(-1)?.click(); true`)
    await sleep(300)
  } else {
    report('工作区：干净工作树显示空状态', true, '0 changes')
  }

  const traversal = await api('/api/workspace/file?path=../../etc/passwd')
  report('工作区：拒绝越界路径', traversal.status === 400 || traversal.status === 404, `HTTP ${traversal.status}`)
  const tree = await api('/api/workspace/tree')
  const leaked = (tree.body?.entries ?? []).some((entry) => /(^|\/)\.env(\.|$)/.test(entry.path))
  report('工作区：敏感文件不进入文件树', leaked === false)

  // ---------- 3. 斜杠内置命令 ----------
  await evalJs(click('[data-testid="composer-commands"]'))
  await waitFor(
    `document.querySelectorAll('[data-testid="command-item"]').length > 0`,
    5000,
    '指令菜单'
  )
  const builtinIds = await evalJs(
    `[...document.querySelectorAll('[data-testid="command-item"]')].map((el) => el.dataset.commandId)`
  )
  report(
    '输入区：内置斜杠命令（新建/分支树/导出）',
    ['builtin:new', 'builtin:tree', 'builtin:export'].every((id) => builtinIds.includes(id)),
    JSON.stringify(builtinIds.slice(0, 5))
  )
  await evalJs(click('[data-testid="composer-commands"]'))

  // ---------- 4. @ 工作区文件引用 ----------
  await evalJs(setInput('textarea', '@pack'))
  await waitFor(
    `!!document.querySelector('[data-testid="file-mention-menu"]')`,
    5000,
    '@ 文件菜单'
  )
  await waitFor(
    `[...document.querySelectorAll('[data-testid="file-mention-item"]')].length > 0`,
    8000,
    '@ 文件搜索结果'
  )
  const mentionPaths = await evalJs(
    `[...document.querySelectorAll('[data-testid="file-mention-item"]')].map((el) => el.dataset.path)`
  )
  report(
    '@ 引用：搜索到真实工作区文件',
    mentionPaths.some((path) => path.includes('package.json')),
    JSON.stringify(mentionPaths.slice(0, 3))
  )
  await evalJs(click('[data-testid="file-mention-item"]'))
  await sleep(200)
  const composerValue = await evalJs(`document.querySelector('textarea').value`)
  report('@ 引用：选中后插入路径', composerValue.startsWith('@') && composerValue.includes('package'), composerValue)
  await evalJs(setInput('textarea', ''))

  // ---------- 5. 真实回合 + 排队 ----------
  await evalJs(`window.__amadeus.sessionStore.getState().sendMessage('只回复：甲')`)
  await waitFor(`window.__amadeus.sessionStore.getState().stream.streaming`, 10_000, '第一回合开始')
  await evalJs(setInput('textarea', '只回复：乙'))
  await waitFor(`!document.querySelector('[data-testid="queue-send-button"]').disabled`, 3000, '排队按钮可用')
  await evalJs(click('[data-testid="queue-send-button"]'))
  await waitFor(
    `document.querySelectorAll('[data-testid="queued-item"]').length === 1`,
    5000,
    '排队项出现'
  )
  report('排队：生成中继续发送进入队列', true)

  await waitFor(
    `!window.__amadeus.sessionStore.getState().stream.streaming &&
     ((window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}] ?? []).length >= 4 ||
      !!window.__amadeus.sessionStore.getState().turnErrors[${JSON.stringify(sid)}])`,
    180_000,
    '两回合结束'
  )
  const llmFailed = await evalJs(
    `!!window.__amadeus.sessionStore.getState().turnErrors[${JSON.stringify(sid)}]`
  )
  let llmOk = false
  if (llmFailed) {
    skip('排队：回合结束后自动发出', '本机 LLM 不可用')
    skip('分支树：编辑产生的分支', '本机 LLM 不可用')
    skip('导出：Markdown 内容', '本机 LLM 不可用')
    await evalJs(`window.__amadeus.sessionStore.getState().clearQueued(${JSON.stringify(sid)}); true`).catch(() => {})
  } else {
    const messages = await evalJs(
      `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}]`
    )
    llmOk =
      messages.filter((message) => message.role === 'user').length === 2 &&
      messages.filter((message) => message.role === 'assistant').length === 2
    report(
      '排队：回合结束后自动发出',
      llmOk && messages.at(-1).content.includes('乙'),
      `messages=${messages.length}`
    )
    report('排队：发送后队列清空', (await evalJs(`document.querySelectorAll('[data-testid="queued-item"]').length`)) === 0)
    await waitFor(`!!document.querySelector('[data-testid="context-meter"]')`, 5000, '上下文读数')
    report('上下文估算读数显示', true, await evalJs(`document.querySelector('[data-testid="context-meter"]').textContent`))

    // 命令面板搜消息正文
    await evalJs(`window.__amadeus.uiStore.getState().setCommandPaletteOpen(false); true`)
    await evalJs(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); true`
    )
    await waitFor(`!!document.querySelector('[data-testid="palette-input"]')`, 5000, '命令面板')
    await evalJs(setInput('[data-testid="palette-input"]', '只回复'))
    await waitFor(
      `document.querySelector('[data-testid="command-palette"]')?.textContent?.includes('消息命中')`,
      8000,
      '命令面板消息命中'
    )
    report('命令面板：可搜消息正文', true)
    await evalJs(
      `document.querySelector('[data-testid="palette-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`
    )
    await sleep(300)

    // ---------- 6. 分支树 ----------
    const firstUserId = await evalJs(
      `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}].find((message) => message.role === 'user').id`
    )
    await evalJs(
      `window.__amadeus.sessionStore.getState().editMessage(${JSON.stringify(firstUserId)}, '只回复：第三版')`
    )
    await waitFor(
      `!window.__amadeus.sessionStore.getState().stream.streaming &&
       (window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}] ?? []).length === 2 &&
       (window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}].at(-1)?.content ?? '').includes('第三版')`,
      120_000,
      '编辑分支完成'
    )
    await evalJs(
      `(async () => { await window.__amadeus.sessionStore.getState().refreshSessions(); return true })()`
    )
    await waitFor(
      `!document.querySelector('[data-testid="open-branch-tree"]').disabled`,
      10_000,
      '分支树按钮可用'
    )
    await evalJs(click('[data-testid="open-branch-tree"]'))
    await waitFor(`!!document.querySelector('[data-testid="branch-tree"]')`, 8000, '分支树弹窗')
    await waitFor(
      `document.querySelectorAll('[data-testid="branch-tree-node"]').length >= 6`,
      8000,
      '分支树节点'
    )
    const nodes = await evalJs(
      `[...document.querySelectorAll('[data-testid="branch-tree-node"]')].map((el) => ({
        active: el.dataset.active,
        id: el.dataset.nodeId,
        text: el.textContent
      }))`
    )
    const activeCount = nodes.filter((node) => node.active === 'true').length
    const inactiveCount = nodes.filter((node) => node.active === 'false').length
    report(
      '分支树：显示全部新旧分支',
      nodes.length >= 6 && activeCount === 2 && inactiveCount >= 4,
      `nodes=${nodes.length} active=${activeCount}`
    )
    const target = nodes.find(
      (node) => node.active === 'false' && node.text.includes('只回复：甲')
    )
    if (!target) {
      report('分支树：点旧分支切回', false, '没有找到旧分支节点')
    } else {
      await evalJs(
        `document.querySelector('[data-testid="branch-tree-node"][data-node-id="${target.id}"]').click(); true`
      )
      await waitFor(`!document.querySelector('[data-testid="branch-tree"]')`, 10_000, '分支树关闭')
      await waitFor(
        `(window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}] ?? []).length === 4 &&
         (window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}][0]?.content ?? '').includes('只回复：甲')`,
        10_000,
        '切回旧分支'
      )
      report('分支树：点旧分支切回该分支', true)
    }

    // ---------- 7. 导出 Markdown ----------
    rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
    mkdirSync(DOWNLOAD_DIR, { recursive: true })
    await cdp.call('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true
    })
    await evalJs(click('[data-testid="export-session"]'))
    let exported = null
    for (let attempt = 0; attempt < 40 && !exported; attempt += 1) {
      await sleep(250)
      if (existsSync(DOWNLOAD_DIR)) {
        const files = readdirSync(DOWNLOAD_DIR)
        if (files.length > 0) exported = files[0]
      }
    }
    report('导出：生成 Markdown 文件', Boolean(exported), exported ?? '')
    if (exported) {
      const text = readFileSync(`${DOWNLOAD_DIR}/${exported}`, 'utf8')
      const expected = await evalJs(
        `window.__amadeus.sessionStore.getState().messages[${JSON.stringify(sid)}].map((message) => message.content).filter(Boolean)`
      )
      const hasAllMessages = expected.every((content) => text.includes(content))
      report(
        '导出：内容来自真实落库消息',
        hasAllMessages && text.includes('## Amadeus'),
        text.slice(0, 60).replace(/\n/g, ' ')
      )
    } else {
      report('导出：内容来自真实落库消息', false, '文件未生成')
    }
  }

  // ---------- 8. 完成通知设置 ----------
  const origin = await evalJs('location.origin')
  await cdp.call('Page.navigate', { url: `${origin}/settings` })
  await sleep(900)
  await evalJs(
    `[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('通用'))?.click(); true`
  )
  await waitFor(
    `[...document.querySelectorAll('label')].some((label) => label.textContent?.includes('回复完成时通知'))`,
    8000,
    '完成通知开关'
  )
  report('设置：完成通知开关存在', true)

  // ---------- 汇总 ----------
  const failed = results.filter((item) => item.ok === false)
  const skipped = results.filter((item) => item.skipped)
  console.log(
    `\n=== ${results.length - failed.length - skipped.length}/${results.length - skipped.length} 通过` +
      `${skipped.length ? `，${skipped.length} 跳过` : ''} ===`
  )
  if (failed.length > 0) {
    console.log('失败项：')
    for (const item of failed) console.log(`  - ${item.name}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`\nE2E 中断：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await cleanupOnce()
  cdp.close()
}
