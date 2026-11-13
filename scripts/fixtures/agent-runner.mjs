/** PIAM-6 无外网/无 shell 的真实进程 fixture；提示词仅作为字节输入和 JSON 测试指令。 */
import { appendFileSync, existsSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'

let input = process.argv[2]
if (input === undefined) {
  input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
}
const directives = [...input.matchAll(/^PIAM_FIXTURE:(.+)$/gm)]
const directive = directives.length ? JSON.parse(directives.at(-1)[1]) : {}
const start = { pid: process.pid, input, cwd: process.cwd() }
appendFileSync(join(process.cwd(), '.fixture-starts.jsonl'), `${JSON.stringify(start)}\n`)
process.stdout.write(`FIXTURE_START ${JSON.stringify(start)}\n`)
process.stdout.write(`FIXTURE_INPUT ${JSON.stringify(input)}\n`)

if (directive.release && !existsSync(directive.release)) {
  const parent = process.ppid
  await new Promise((resolve) => {
    let timer
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      watcher.close()
      resolve()
    }
    const check = () => {
      // brain 崩溃后不把 fixture 留成孤儿；普通 hold 只能由测试文件条件放行。
      if (parent <= 1 || process.ppid !== parent) process.exit(0)
      if (existsSync(directive.release)) finish()
      else timer = setTimeout(check, 50)
    }
    const watcher = watch(dirname(directive.release), () => {
      if (existsSync(directive.release)) finish()
    })
    check()
  })
}
process.stdout.write('FIXTURE_DONE\n')
if (directive.fail) {
  process.stderr.write('FIXTURE_EXPECTED_FAILURE\n')
  process.exitCode = 7
}
