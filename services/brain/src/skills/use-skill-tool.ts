/**
 * use_skill 工具（Claude Code 风格）：按名返回 SKILL.md 正文。
 * 与其他工具同构（TypeBox schema + execute throw 语义），
 * 只依赖已加载的 Skill[]（由 agentTurn 注入），不自行读盘。
 */

import { formatSkillInvocation } from '@earendil-works/pi-agent-core/node'
import type { AgentTool, Skill } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

const useSkillSchema = Type.Object({
  name: Type.String({ description: 'skill 名称（如 haiku-writer）' })
})

export function createUseSkillTool(skills: Skill[]): AgentTool<typeof useSkillSchema> {
  return {
    name: 'use_skill',
    label: '读取技能',
    description:
      '按名称读取某个 skill 的完整指令文件（SKILL.md）。当任务与某个 skill 的描述匹配时先调用它获取详细操作步骤。' +
      '当前可用 skill：' +
      skills.map((s) => `${s.name}（${s.description}）`).join('、'),
    parameters: useSkillSchema,
    execute: async (toolCallId, params) => {
      const name = String(params?.name ?? '')
      const skill = skills.find((s) => s.name === name)
      if (!skill) {
        throw new Error(`未知 skill：${name}。可用：${skills.map((s) => s.name).join(', ') || '（无）'}`)
      }
      return { content: [{ type: 'text', text: formatSkillInvocation(skill) }], details: {} }
    }
  }
}
