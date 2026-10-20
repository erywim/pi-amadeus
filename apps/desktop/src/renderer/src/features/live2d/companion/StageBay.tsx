import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DivergenceMeter } from '@renderer/components/effects/DivergenceMeter'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { useLive2dStore } from '@renderer/stores/live2dStore'
import { Live2DStage } from '../Live2DStage'
import { DebugInput } from '../DebugInput'
import type { Live2DEngine } from '../lib/live2d-engine'
import { poke } from '../poke'
import { useCompanionStatus } from './useCompanionStatus'
import { useStageGesture } from './useStageGesture'

/**
 * 舞台区：PIXI 画布 + 实验台氛围装饰（点阵标尺 / 取景框 / 世界线计 /
 * 系统铭牌 / 落地影 / 点击提示）。说话与倾听时边缘亮起氛围环。
 * 角色上按住拖动换位置、滚轮缩放，摆位写回 live2dStore（按模型记忆）。
 */
export function StageBay(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useCompanionStatus()
  const pokeNotice = useCompanionStore((s) => s.pokeNotice)
  const [tipFaded, setTipFaded] = React.useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<Live2DEngine | null>(null)
  const modelId = useLive2dStore((s) => s.modelId)
  // 订阅摆位：拖动/滚轮写回 store 时重算落地影的位置与宽度
  const avatar = useLive2dStore((s) => s.avatars[s.modelId])
  const gesture = useStageGesture({ engine, containerRef: stageRef, modelId })

  // 落地影跟着角色脚底走：引擎给的是可见网格包围盒（不含画布透明留白）
  const groundStyle = useMemo(() => {
    const bounds = engine?.getModelBounds()
    if (!bounds || gesture.view.width <= 0) return undefined
    return {
      left: bounds.x + bounds.width / 2,
      bottom: gesture.view.height - (bounds.y + bounds.height),
      width: Math.min(bounds.width * 0.63, gesture.view.width * 0.46, 380)
    }
    // avatar 是订阅触发器：摆位变化后引擎包围盒才是新值
  }, [engine, avatar, gesture.view])

  function onStageClick(e: React.MouseEvent<HTMLDivElement>): void {
    // 拖动松手后浏览器补发的 click 不再算"点她"
    if (gesture.consumeDragClick()) return
    // 点击落在可交互控件上（世界线计/按钮等）不算"点她"
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    // 引擎调试钩子（live2d-engine 挂载时写入；戳一下走同一条手势路径）
    if (poke(window.__live2d)) pokeNotice()
  }

  return (
    <div
      ref={stageRef}
      className="stage-pattern stage-edge relative min-h-0 cursor-grab select-none overflow-hidden active:cursor-grabbing"
      data-status={status}
      onClick={onStageClick}
      onPointerDown={(e) => {
        setTipFaded(true)
        gesture.handlers.onPointerDown(e)
      }}
      onPointerMove={gesture.handlers.onPointerMove}
      onPointerUp={gesture.handlers.onPointerUp}
      onPointerCancel={gesture.handlers.onPointerCancel}
      onLostPointerCapture={gesture.handlers.onLostPointerCapture}
      onWheel={gesture.onWheel}
    >
      <Live2DStage className="z-[1]" onReady={(ready) => setEngine(ready)} />

      {/* 取景框四角 */}
      <i className="frame-corners z-[2]" aria-hidden />

      {/* 世界线变动率计 */}
      <div className="absolute left-[26px] top-[26px] z-[3]">
        <DivergenceMeter />
      </div>

      {/* 系统铭牌 */}
      <div className="pointer-events-none absolute right-7 top-[30px] z-[2] font-mono text-[10px] tracking-[0.2em] text-[#5d6372]">
        AMADEUS SYSTEM&nbsp;<b className="font-normal text-lab-amber-dim">//</b>&nbsp;BUILD 0.96.1
      </div>

      {/* 角色落地阴影 */}
      <div className="char-ground z-[1]" style={groundStyle} aria-hidden />

      {/* 点击提示（首次交互后淡出） */}
      <div className={tipFaded ? 'stage-tip stage-tip-faded z-[4]' : 'stage-tip z-[4]'}>
        {t('companion.stageTip')}
      </div>

      {/* 开发调试入口仅 dev 构建可见 */}
      {import.meta.env.DEV && <DebugInput />}
    </div>
  )
}
