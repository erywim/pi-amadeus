/**
 * skill → systemPrompt 注入（复用 pi 的 formatSkillsForSystemPrompt）：
 * 只负责"能力列表怎么出现在提示词里"，不关心加载与启停。
 */

import { formatSkillsForSystemPrompt } from '@earendil-works/pi-agent-core/node'
import type { Skill } from '@earendil-works/pi-agent-core'

/** systemPrompt 追加片段（无可用 skill 时为空串，调用方直接拼接） */
export function skillsPrompt(skills: Skill[]): string {
  return formatSkillsForSystemPrompt(skills)
}
