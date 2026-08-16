/** skill 子系统出口：注册表（加载/启停）、提示词注入、use_skill 工具 */
export { loadSkillBundle, listSkills, setSkillEnabled, type SkillInfo } from './registry.ts'
export { skillsPrompt } from './prompt.ts'
export { createUseSkillTool } from './use-skill-tool.ts'
