import type { SseEvent } from '@pi-amadeus/shared'

/**
 * SSE 响应封装：把事件生成器包成 text/event-stream Response。
 * 客户端断开（signal abort）→ 生成器收到 abort → 静默结束，不再写 error。
 */
export function sseResponse(
  generate: (signal: AbortSignal) => AsyncGenerator<SseEvent>,
  requestSignal?: AbortSignal
): Response {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (requestSignal) {
    if (requestSignal.aborted) controller.abort()
    else requestSignal.addEventListener('abort', onAbort, { once: true })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      try {
        for await (const event of generate(controller.signal)) {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error)
          streamController.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', message } satisfies SseEvent)}\n\n`)
          )
        }
      } finally {
        if (requestSignal) requestSignal.removeEventListener('abort', onAbort)
        try {
          streamController.close()
        } catch {
          // 已关闭（客户端取消）
        }
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  })
}
