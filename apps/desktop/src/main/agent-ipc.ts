import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

/** 只为受信任主窗口提供工作台 HTTP 桥；file:// 的 Origin:null 不能直接获准管理电脑。 */
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  try {
    const url = new URL(frame.url)
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!app.isPackaged && dev) return url.origin === new URL(dev).origin
    return url.protocol === 'file:' && fileURLToPath(url).split('?')[0] === resolve(__dirname, '../renderer/index.html')
  } catch {
    return false
  }
}

function brainUrl(path: string): URL {
  const base = new URL(process.env['BRAIN_URL'] || process.env['VITE_BRAIN_URL'] || 'http://127.0.0.1:3002')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') {
    throw new Error('Agent 管理桥只允许本机 Brain')
  }
  const url = new URL(path, base.origin)
  if (url.origin !== base.origin || !/^\/api\/(agents|collaboration)(?:\/|$)/.test(url.pathname)) {
    throw new Error('Agent 管理桥拒绝此路径')
  }
  return url
}

export function registerAgentIpc(): void {
  const streams = new Map<string, AbortController>()
  ipcMain.handle('agents:request', async (event, path: unknown, method: unknown, body: unknown) => {
    if (!trusted(event)) throw new Error('不可信的窗口')
    if (typeof path !== 'string' || typeof method !== 'string' || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error('无效的 Agent 请求')
    }
    const data = body === undefined ? undefined : JSON.stringify(body)
    if (data && data.length > 200_000) throw new Error('请求过大')
    const response = await fetch(brainUrl(path), {
      method,
      headers: data ? { 'Content-Type': 'application/json' } : undefined,
      body: data,
      signal: AbortSignal.timeout(15_000)
    })
    const text = await response.text()
    return { status: response.status, body: JSON.parse(text) as unknown }
  })
  ipcMain.on('agents:subscribe', (event, id: unknown, userId: unknown, after: unknown) => {
    if (!trusted(event) || typeof id !== 'string' || id.length > 80 || typeof userId !== 'string' || userId.length > 100 || typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return
    const key = `${event.sender.id}:${id}`
    streams.get(key)?.abort()
    // 同一窗口只需一个工作台订阅，旧连接先释放，避免路由反复开合累积监听。
    for (const [oldKey, controller] of streams) {
      if (oldKey.startsWith(`${event.sender.id}:`)) controller.abort()
    }
    const controller = new AbortController()
    streams.set(key, controller)
    const onDestroyed = (): void => controller.abort()
    event.sender.once('destroyed', onDestroyed)
    void (async () => {
      const params = new URLSearchParams({ userId, after: String(after) })
      const response = await fetch(brainUrl(`/api/agents/events?${params.toString()}`), { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`事件订阅失败: HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          if (!event.sender.isDestroyed()) event.sender.send('agents:chunk', { id, chunk: decoder.decode(next.value, { stream: true }) })
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    })().catch(() => {
      // 网络断开由渲染层重连；订阅结束不取消任何实际任务。
    }).finally(() => {
      if (streams.get(key) === controller) streams.delete(key)
      if (!event.sender.isDestroyed()) {
        event.sender.removeListener('destroyed', onDestroyed)
        event.sender.send('agents:end', { id })
      }
    })
  })
  ipcMain.on('agents:unsubscribe', (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') return
    streams.get(`${event.sender.id}:${id}`)?.abort()
  })
  app.on('before-quit', () => {
    for (const controller of streams.values()) controller.abort()
  })
}
