import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { IdleScheduler } from './lib/idle'
import { createEngine, type Live2DEngine } from './lib/live2d-engine'

/**
 * Live2D 渲染舞台：PIXI 画布 + 引擎生命周期。
 * canvas DOM 归 React，引擎 destroy 只清理渲染器不删节点；
 * StrictMode 双挂载安全（destroy 幂等 + 迟到 Promise 静默丢弃）。
 */
export function Live2DStage({ className }: { className?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const engine: Live2DEngine = createEngine(canvas, container)
    let idle: IdleScheduler | null = null

    void engine
      .load()
      .then(() => {
        if (engine.isDestroyed()) return
        idle = new IdleScheduler(engine)
        idle.start()
        setReady(true)
      })
      .catch(() => {
        if (!engine.isDestroyed()) setError(true)
      })

    return () => {
      idle?.stop()
      engine.destroy()
    }
  }, [])

  return (
    <div ref={containerRef} className={cn('absolute inset-0 overflow-hidden', className)}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {!ready && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="crt-flicker font-mono text-xs tracking-[0.3em] text-primary/70">
            {t('live2d.loading')}
          </span>
        </div>
      )}
      {error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-xs text-destructive">{t('live2d.loadError')}</span>
        </div>
      )}
    </div>
  )
}
