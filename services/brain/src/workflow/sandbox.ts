import vm from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'

/**
 * 工作流脚本沙箱（独立 worker 线程的入口）。
 *
 * 隔离做法：
 * 1. vm 上下文里**不注入任何宿主对象**。JSON / Math / Date / Array / Promise 等
 *    都是 vm 自己 realm 的内建对象，不是主线程传进来的——因此没有
 *    `obj.constructor.constructor('return process')` 这条经典逃逸链。
 * 2. 宿主能力只通过一个字符串桥接函数暴露：脚本 → 宿主传 JSON 字符串，
 *    宿主 → 脚本也回 JSON 字符串。桥接函数在 bootstrap 里被闭包捕获后即从
 *    全局删除，脚本拿不到它的引用。
 * 3. 线程用空 env 启动（不继承 LLM 密钥等环境变量），并且由主线程
 *    `worker.terminate()` 兜底超时/取消——同步与异步死循环都能杀掉。
 *
 * 它仍不是经过审计的安全容器：与主进程共用同一个 Node 二进制，
 * vm 自身的逃逸漏洞无法在此层防御。要更强的保证需要独立进程或容器。
 */

interface SandboxInput {
  body: string
  argsJson: string
  syncTimeoutMs: number
}

const port = parentPort
if (!port) throw new Error('sandbox.ts 必须在 worker 线程中运行')

const input = workerData as SandboxInput

/** 宿主 → 脚本：投递子代理结果（由 bootstrap 定义、这里捕获引用后从全局删除） */
let deliver: ((id: number, payload: string) => void) | null = null

/** 脚本 → 宿主：桥接函数。bootstrap 捕获它之后会从全局删除 */
function bridge(payload: unknown): void {
  if (typeof payload !== 'string') return
  let message: Record<string, unknown>
  try {
    message = JSON.parse(payload) as Record<string, unknown>
  } catch {
    return
  }
  if (message.t === 'agent') {
    port!.postMessage({
      t: 'agent',
      id: Number(message.id),
      prompt: String(message.prompt ?? ''),
      optsJson: typeof message.optsJson === 'string' ? message.optsJson : 'null'
    })
    return
  }
  if (message.t === 'phase') {
    port!.postMessage({ t: 'phase', title: String(message.title ?? '') })
    return
  }
  if (message.t === 'log') {
    port!.postMessage({ t: 'log', message: String(message.message ?? '') })
  }
}

/**
 * 在 vm 上下文里安装脚本可用的 API。
 * 所有函数都在上下文 realm 里创建；宿主只出现在 gobalThis.__send 上，
 * 安装完成后立即删除。
 */
const BOOTSTRAP = `(() => {
  'use strict'
  const send = globalThis.__send
  const argsJson = globalThis.__argsJson
  delete globalThis.__send
  delete globalThis.__argsJson

  const pending = new Map()
  let seq = 0

  globalThis.__resolve = (id, payload) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    let data
    try { data = JSON.parse(payload) } catch (error) {
      entry.reject(new Error('子代理结果解析失败'))
      return
    }
    if (data && data.ok) { entry.resolve(data.value); return }
    const failure = new Error((data && data.error) || '子代理失败')
    if (data && data.abort) failure.__wfAbort = true
    entry.reject(failure)
  }

  const emit = (payload) => send(JSON.stringify(payload))
  const log = (message) => emit({ t: 'log', message: String(message) })

  globalThis.agent = (prompt, opts) => new Promise((resolve, reject) => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      reject(new TypeError('agent(prompt) 的 prompt 必须是非空字符串'))
      return
    }
    let optsJson
    try { optsJson = JSON.stringify(opts === undefined ? null : opts) } catch (error) {
      reject(new TypeError('agent 的 opts 必须可 JSON 序列化'))
      return
    }
    const id = ++seq
    pending.set(id, { resolve, reject })
    emit({ t: 'agent', id, prompt, optsJson })
  })

  globalThis.log = log
  globalThis.phase = (title) => {
    if (typeof title !== 'string' || title.trim() === '') return
    emit({ t: 'phase', title })
  }

  globalThis.parallel = async (thunks) => {
    if (!Array.isArray(thunks)) throw new TypeError('parallel(thunks) 需要函数数组')
    if (thunks.length > 4096) throw new Error('parallel 一次最多 4096 项')
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk()
      } catch (error) {
        if (error && error.__wfAbort) throw error
        log('parallel 中的一项失败：' + (error && error.message ? error.message : String(error)))
        return null
      }
    }))
  }

  globalThis.pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new TypeError('pipeline(items, ...stages) 需要数组')
    if (items.length > 4096) throw new Error('pipeline 一次最多 4096 项')
    return Promise.all(items.map(async (item, index) => {
      let previous = item
      try {
        for (const stage of stages) previous = await stage(previous, item, index)
        return previous
      } catch (error) {
        if (error && error.__wfAbort) throw error
        log('pipeline 第 ' + (index + 1) + ' 项失败：' + (error && error.message ? error.message : String(error)))
        return null
      }
    }))
  }

  globalThis.console = { log, warn: log, error: log, info: log, debug: log }
  try { globalThis.args = JSON.parse(argsJson) } catch (error) { globalThis.args = null }
})()`

const context = vm.createContext(
  { __send: bridge, __argsJson: input.argsJson },
  { codeGeneration: { strings: false, wasm: false } }
)

try {
  vm.runInContext(BOOTSTRAP, context, { timeout: input.syncTimeoutMs })
  // 拿到投递函数的上下文引用后立刻从全局删除：脚本无法伪造子代理结果
  deliver = vm.runInContext('__resolve', context) as (id: number, payload: string) => void
  vm.runInContext('delete globalThis.__resolve', context)
} catch (error) {
  port.postMessage({ t: 'error', message: `沙箱初始化失败：${errorText(error)}` })
}

if (deliver) {
  port.on('message', (message: { t: string; id: number; ok: boolean; valueJson?: string; error?: string; abort?: boolean }) => {
    if (message?.t !== 'agentResult') return
    const payload = message.ok
      ? JSON.stringify({ ok: true, value: parseJson(message.valueJson) })
      : JSON.stringify({ ok: false, error: message.error ?? '子代理失败', abort: message.abort === true })
    deliver?.(Number(message.id), payload)
  })

  // 顶层 return 只能出现在函数体里：包一层 async IIFE
  let script: vm.Script
  try {
    script = new vm.Script(`(async () => {\n${input.body}\n})()`, { filename: 'workflow.js' })
  } catch (error) {
    port.postMessage({ t: 'error', message: `脚本语法错误：${errorText(error)}` })
    script = undefined as never
  }

  if (script) {
    try {
      const result = script.runInContext(context, { timeout: input.syncTimeoutMs })
      void (result as Promise<unknown>).then(
        (value) => {
          port.postMessage({ t: 'done', valueJson: safeStringify(value) })
        },
        (error: unknown) => {
          port.postMessage({ t: 'error', message: errorText(error) })
        }
      )
    } catch (error) {
      port.postMessage({ t: 'error', message: errorText(error) })
    }
  }
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value === undefined ? null : value)
    return text === undefined ? 'null' : text
  } catch {
    return JSON.stringify({ __unserializable: true })
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
