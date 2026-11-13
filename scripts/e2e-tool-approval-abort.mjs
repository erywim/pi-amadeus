/** PIAM-6：在等待 bash 审批时停止 Agent，不得因双重 settle 留下永远 pending 的回合。 */
import assert from 'node:assert/strict'
import { requestBashConfirm, resolveBashConfirm } from '../services/brain/src/tools/confirm.ts'

const controller = new AbortController()
const { promise } = requestBashConfirm({
  turnId: 'approval-abort-regression',
  toolCallId: 'pwd',
  command: 'pwd',
  timeoutMs: 500,
  signal: controller.signal
})
const result = promise.then(() => 'approved', (error) => error.deniedReason)
controller.abort()
let timer
try {
  const outcome = await Promise.race([
    result,
    new Promise((resolve) => { timer = setTimeout(() => resolve('HUNG'), 100) })
  ])
  assert.equal(outcome, 'aborted', '等待审批的任务停止后必须立即 reject，不能永远 pending')
  assert.deepEqual(resolveBashConfirm('approval-abort-regression', 'pwd', true), { ok: false, status: 'notFound' })
  const alreadyAborted = requestBashConfirm({
    turnId: 'already-aborted', toolCallId: 'pwd', command: 'pwd', timeoutMs: 500, signal: controller.signal
  })
  assert.equal(await alreadyAborted.promise.catch((error) => error.deniedReason), 'aborted')
  console.log('PASS  bash 审批取消立即结束、迟到回执拒绝、已取消 signal 不等待超时')
} finally {
  clearTimeout(timer)
}
