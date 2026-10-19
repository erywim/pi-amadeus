/**
 * E2E 回归套件总入口：依次运行本目录下所有 e2e-*.mjs 专项脚本。
 *
 * 前置（与专项脚本一致）：
 *   - 桌面端 dev 已启动（Electron 开 9222 CDP 调试端口）
 *   - brain 服务运行中（默认 http://localhost:3002）
 * 前置不满足时不逐个跑，直接报错退出——回归套件的价值在于
 * 绿就是真的绿，"环境没起"不能被误读成"测试全过"。
 *
 * 用法：node scripts/e2e-all.mjs [脚本名子串过滤，如 interrupt]
 * 新写的 e2e-*.mjs 自动被本套件收编，无需登记。
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const self = fileURLToPath(import.meta.url)
const filter = process.argv[2]

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'
const BRAIN = process.env.BRAIN_URL ?? 'http://localhost:3002'

async function checkPreconditions() {
  const problems = []
  try {
    const res = await fetch(`${CDP_HTTP}/json/list`)
    const targets = await res.json()
    if (!targets.some((t) => t.type === 'page')) problems.push(`${CDP_HTTP} 上没有 page 目标（桌面端 dev 未启动？）`)
  } catch {
    problems.push(`CDP ${CDP_HTTP} 不可达（桌面端 dev 未启动？）`)
  }
  try {
    await fetch(BRAIN, { signal: AbortSignal.timeout(3000) })
  } catch {
    problems.push(`brain ${BRAIN} 不可达（services/brain 未启动？）`)
  }
  return problems
}

const files = (await readdir(here))
  .filter((f) => /^e2e(-[\w-]+)?\.mjs$/.test(f))
  .filter((f) => join(here, f) !== self)
  .filter((f) => !filter || f.includes(filter))
  .sort()

if (files.length === 0) {
  console.error(filter ? `没有匹配 "${filter}" 的 e2e 脚本` : '没有找到 e2e-*.mjs 脚本')
  process.exit(1)
}

const problems = await checkPreconditions()
if (problems.length > 0) {
  console.error(`E2E 前置不满足，未运行：\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}

console.log(`E2E 回归套件：${files.length} 个脚本\n`)

const summary = []
for (const f of files) {
  console.log(`──── ${f} ${'─'.repeat(Math.max(4, 60 - f.length))}`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, f)], { stdio: 'inherit' })
    child.on('close', resolve)
  })
  summary.push({ f, code })
  console.log('')
}

const failed = summary.filter((s) => s.code !== 0)
console.log('════ 套件汇总 ════')
for (const s of summary) console.log(`${s.code === 0 ? 'PASS' : 'FAIL'}  ${s.f}${s.code ? `（退出码 ${s.code}）` : ''}`)
console.log(`\n=== ${summary.length - failed.length}/${summary.length} 个脚本通过 ===`)
if (failed.length > 0) process.exitCode = 1
