import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DivergenceMeter } from '@renderer/components/effects/DivergenceMeter'
import { useCompanionStore } from '@renderer/stores/companionStore'
import { Live2DStage } from '../Live2DStage'
import { DebugInput } from '../DebugInput'
import { poke } from '../poke'
import { useCompanionStatus } from './useCompanionStatus'

/**
 * 舞台区：PIXI 画布 + 实验台氛围装饰（点阵标尺 / 取景框 / 世界线计 /
 * 系统铭牌 / 落地影 / 点击提示）。说话与倾听时边缘亮起氛围环。
 */
export function StageBay(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useCompanionStatus()
  const pokeNotice = useCompanionStore((s) => s.pokeNotice)
  const [tipFaded, setTipFaded] = React.useState(false)

  function onStageClick(e: React.MouseEvent<HTMLDivElement>): void {
    // 点击落在可交互控件上（世界线计/按钮等）不算"点她"
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    // 引擎调试钩子（live2d-engine 挂载时写入；戳一下走同一条手势路径）
    if (poke(window.__live2d)) pokeNotice()
  }

  return (
    <div
      className="stage-pattern stage-edge relative min-h-0 overflow-hidden"
      data-status={status}
      onClick={onStageClick}
      onPointerDown={() => setTipFaded(true)}
    >
      <Live2DStage className="z-[1]" />

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
      <div className="char-ground z-[1]" aria-hidden />

      {/* 点击提示（首次交互后淡出） */}
      <div className={tipFaded ? 'stage-tip stage-tip-faded z-[4]' : 'stage-tip z-[4]'}>
        {t('companion.stageTip')}
      </div>

      {/* 开发调试入口仅 dev 构建可见 */}
      {import.meta.env.DEV && <DebugInput />}
    </div>
  )
}
