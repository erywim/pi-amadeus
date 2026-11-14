/**
 * 会话标题归回归（不依赖桌面端，直接跑大脑的 SQLite 层）：
 *  - 用户手动命名后，后到的自动标题不能覆盖
 *  - 空标题仍然可以被首轮自动标题填充
 *
 * 背景：首轮回复结束后 generateTitle 是异步的；如果用户在这期间改了标题，
 * 原来的无条件 UPDATE 会把用户命名冲掉（LESSONS「默认值不覆盖用户值」）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../services/brain/src/db.ts'

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'amadeus-title-'))
const db = createDb({ path: join(dir, 'title.db') })
try {
  await db.init()
  const { id: userId } = await db.resolveUser('title-e2e')

  await db.touchSession({ id: 'manual-first', userId, channel: 'desktop' })
  await db.renameSession('manual-first', '用户命名')
  await db.setSessionTitle('manual-first', '自动标题')
  const manual = await db.getSession('manual-first')
  report('手动命名后，后到的自动标题不覆盖', manual?.title === '用户命名', manual?.title)

  await db.touchSession({ id: 'auto-first', userId, channel: 'desktop' })
  await db.setSessionTitle('auto-first', '自动标题')
  const auto = await db.getSession('auto-first')
  report('空标题可以被自动标题填充', auto?.title === '自动标题', auto?.title)
} catch (error) {
  report('脚本执行完成', false, error instanceof Error ? error.message : String(error))
} finally {
  await db.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
if (passed !== results.length) process.exitCode = 1
