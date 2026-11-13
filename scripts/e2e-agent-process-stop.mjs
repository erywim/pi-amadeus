/** PIAM-6：取消内置 Agent 的 bash 工具必须终止其孙进程，不能只结束壳。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createBashTool } from '../services/brain/src/tools/bash.ts'

if (process.platform === 'win32') {
  console.log('not run: POSIX 进程组回归（Windows taskkill 分支需要 Windows 环境）')
} else {
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-process-stop-'))
  const pidFile = join(dir, 'child.pid')
  const fixture = join(dir, 'worker.mjs')
  let descendant
  try {
    await writeFile(fixture, `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000)`)
    const tool = createBashTool({ cwd: dir, confirmRequest: async () => true })
    const controller = new AbortController()
    const command = `"${process.execPath}" "${fixture}" "${pidFile}" & wait`
    const running = tool.execute('stop-proof', { command }, controller.signal).catch((error) => error)
    const deadline = Date.now() + 5000
    for (;;) {
      try { descendant = Number(await readFile(pidFile, 'utf8')); break } catch { /* 等待进程真正进入执行态 */ }
      if (Date.now() > deadline) throw new Error('测试子进程未就绪')
      await delay(20)
    }
    controller.abort()
    const result = await running
    assert.equal(result.deniedReason, 'aborted')
    const goneDeadline = Date.now() + 1500
    let alive = true
    while (Date.now() < goneDeadline) {
      try { process.kill(descendant, 0) } catch { alive = false; break }
      await delay(20)
    }
    assert.equal(alive, false, '停止工具后孙进程仍在运行')
    console.log('PASS  停止内置 bash 会终止自己拥有的整个进程组')
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch { /* 已结束 */ } }
    await rm(dir, { recursive: true, force: true })
  }
}
