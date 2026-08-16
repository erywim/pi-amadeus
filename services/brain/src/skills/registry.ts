/**
 * skill 注册表层（加载 + 启停状态）——只负责"有哪些 skill、各自是否启用"。
 * 加载复用 pi-agent-core 的 loadSkills（递归扫描 SKILL.md + YAML frontmatter 校验），
 * 不做格式与提示词相关的事（见 prompt.ts / use-skill-tool.ts）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { NodeExecutionEnv, loadSkills } from '@earendil-works/pi-agent-core/node'
import type { Skill } from '@earendil-works/pi-agent-core'
import type { BrainConfig } from '../config.ts'

const STATE_FILE = '.amadeus-state.json'

interface SkillState {
  /** 被用户停用的 skill 名（未列出的默认启用） */
  disabled: string[]
}

export interface SkillInfo {
  name: string
  description: string
  filePath: string
  enabled: boolean
  /** 只注入能力列表、模型不可主动调用（需用户显式请求） */
  disableModelInvocation?: boolean
}

function readState(dir: string): SkillState {
  try {
    const raw = JSON.parse(readFileSync(`${dir}/${STATE_FILE}`, 'utf8')) as Partial<SkillState>
    return { disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((x) => typeof x === 'string') : [] }
  } catch {
    return { disabled: [] }
  }
}

function writeState(dir: string, state: SkillState): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/${STATE_FILE}`, JSON.stringify(state, null, 2))
  } catch (error) {
    console.warn('[skills] 状态文件写入失败：', error)
  }
}

async function loadAll(cfg: BrainConfig): Promise<Skill[]> {
  const { skills } = await loadSkills(new NodeExecutionEnv({ cwd: cfg.skills.dir }), cfg.skills.dir)
  return skills
}

/** 每回合调用：skill 是文件形式，热编辑无需重启 */
export async function loadSkillBundle(cfg: BrainConfig): Promise<{ skills: Skill[] }> {
  const state = readState(cfg.skills.dir)
  const skills = await loadAll(cfg)
  return { skills: skills.filter((s) => !state.disabled.includes(s.name)) }
}

/** 管理页列表：全部 skill + 启停状态（不含正文） */
export async function listSkills(cfg: BrainConfig): Promise<{ dir: string; skills: SkillInfo[] }> {
  const state = readState(cfg.skills.dir)
  const skills = await loadAll(cfg)
  return {
    dir: cfg.skills.dir,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      enabled: !state.disabled.includes(s.name),
      ...(s.disableModelInvocation ? { disableModelInvocation: true } : {})
    }))
  }
}

export async function setSkillEnabled(
  cfg: BrainConfig,
  name: string,
  enabled: boolean
): Promise<{ ok: true; skill: SkillInfo } | { ok: false; status: 'notFound' }> {
  const skills = await loadAll(cfg)
  const target = skills.find((s) => s.name === name)
  if (!target) return { ok: false, status: 'notFound' }
  const state = readState(cfg.skills.dir)
  state.disabled = enabled
    ? state.disabled.filter((n) => n !== name)
    : [...new Set([...state.disabled, name])]
  writeState(cfg.skills.dir, state)
  return {
    ok: true,
    skill: {
      name: target.name,
      description: target.description,
      filePath: target.filePath,
      enabled,
      ...(target.disableModelInvocation ? { disableModelInvocation: true } : {})
    }
  }
}
