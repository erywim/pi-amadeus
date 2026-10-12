/**
 * skill 注册表层（加载 + 启停状态）——只负责"有哪些 skill、各自是否启用"。
 * 加载复用 pi-agent-core 的 loadSkills（递归扫描 SKILL.md + YAML frontmatter 校验），
 * 不做格式与提示词相关的事（见 prompt.ts / use-skill-tool.ts）。
 */

import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * 状态文件损坏标记：解析/校验失败且无法从 .bak 恢复时置 true。
 * 此时状态内容"未知"（未知 ≠ 空），写入一律跳过、绝不覆盖现场，
 * 直到有一次健康读取（文件正常解析，或确定文件不存在）。
 * 注意：按进程级单例设计，前提是一个 brain 进程只服务一个 skills 目录
 * （当前 config 即如此）；若未来同进程多目录，需按 dir 键控。
 */
let stateCorrupted = false

/** 已保留过现场的损坏文件签名（mtimeMs:size），避免同一份损坏现场被反复复制成 .bad-* */
let preservedCorruptSig: string | null = null
let preservedCorruptBadPath: string | null = null

/** 解析并校验状态文本；格式不合法时抛错（由调用方走"未知"处理路径） */
function parseState(text: string): SkillState {
  const raw = JSON.parse(text) as Partial<SkillState> | null
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('顶层必须是对象')
  }
  if (raw.disabled !== undefined && !Array.isArray(raw.disabled)) {
    throw new Error('disabled 字段必须是数组')
  }
  return { disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((x) => typeof x === 'string') : [] }
}

/**
 * 状态文件内容不可信时的处理：
 * (a) 原件复制为 .bad-<时间戳> 保留现场；(b) 尝试读上次写入留下的 .bak 恢复；
 * (c) 连 .bak 也读不出 → 回默认并置"状态损坏"标记（此后 writeState 跳过写入）。
 */
function recoverCorruptState(file: string, reason: string): SkillState {
  let badPath: string | null = null
  try {
    const stat = statSync(file)
    const sig = `${stat.mtimeMs}:${stat.size}`
    if (sig === preservedCorruptSig) {
      badPath = preservedCorruptBadPath
    } else {
      // ISO 时间戳去掉文件名不友好的字符
      badPath = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(file, badPath)
      preservedCorruptSig = sig
      preservedCorruptBadPath = badPath
    }
  } catch (error) {
    console.warn(`[skills] 状态文件${reason}，且保留现场失败：`, error)
  }
  const preservedNote = badPath ?? '（保留失败，请手工备份）'
  try {
    const restored = parseState(readFileSync(`${file}.bak`, 'utf8'))
    stateCorrupted = false
    console.warn(
      `[skills] 状态文件${reason}，原件已保留至 ${preservedNote}；已从 ${file}.bak 恢复启停状态（disabled=${JSON.stringify(restored.disabled)}）`
    )
    return restored
  } catch {
    stateCorrupted = true
    console.warn(
      `[skills] 状态文件${reason}，原件已保留至 ${preservedNote}；无可用 .bak 备份，按默认状态处理，后续写入将被跳过直到读到健康文件`
    )
    return { disabled: [] }
  }
}

function readState(dir: string): SkillState {
  const file = `${dir}/${STATE_FILE}`
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      // 首次运行 / 已被清理：合法情形，磁盘上没有现场要保护，允许后续写入
      stateCorrupted = false
      preservedCorruptSig = null
      preservedCorruptBadPath = null
      return { disabled: [] }
    }
    // 读不出（权限等）= 未知，不是空：走与解析失败相同的保护路径
    return recoverCorruptState(file, `读取失败（${error instanceof Error ? error.message : String(error)}）`)
  }
  try {
    const state = parseState(text)
    // 一次成功的健康读取后解除损坏标记，残留的现场记录一并清掉
    stateCorrupted = false
    preservedCorruptSig = null
    preservedCorruptBadPath = null
    return state
  } catch (error) {
    return recoverCorruptState(file, `解析/校验失败（${error instanceof Error ? error.message : String(error)}）`)
  }
}

function writeState(dir: string, state: SkillState): boolean {
  const file = `${dir}/${STATE_FILE}`
  if (stateCorrupted) {
    // 状态损坏且未能从备份恢复：绝不写入，防止拿"默认猜测"覆盖现场
    console.warn(`[skills] 状态文件此前读取失败且无法从备份恢复，跳过本次写入以免覆盖现场：${file}`)
    return false
  }
  try {
    mkdirSync(dir, { recursive: true })
    let prevMode: number | undefined
    try {
      // 先备份：目标内容自身能解析校验通过才复制为 .bak——若当前文件已损坏
      // （如刚从 .bak 恢复、坏原件尚未被覆盖），跳过备份，免得坏字节毒化好备份
      prevMode = statSync(file).mode
      parseState(readFileSync(file, 'utf8'))
      copyFileSync(file, `${file}.bak`)
    } catch {
      /* 目标不存在/不可读/内容已损坏：没有可备份的健康内容，.bak 保持上一份 */
    }
    // 再原子替换：写临时文件后 rename，失败也不会留下半截目标文件
    const tmp = `${file}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, file)
      // rename 换出新 inode（权限位回落到 umask 默认），还原旧文件的权限位。
      // 必须独立 best-effort：此时落盘已成功，chmod 失败只告警，绝不能抛出
      // （否则外层会把"已生效的写入"谎报成失败 409）。
      if (prevMode !== undefined) {
        try {
          chmodSync(file, prevMode & 0o7777)
        } catch (error) {
          console.warn('[skills] 还原状态文件权限位失败（不影响已完成的写入）：', error)
        }
      }
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 清理失败随上层写入失败一并告警 */
      }
      throw error
    }
    return true
  } catch (error) {
    console.warn('[skills] 状态文件写入失败：', error)
    return false
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
): Promise<{ ok: true; skill: SkillInfo } | { ok: false; status: 'notFound' | 'notPersisted' }> {
  const skills = await loadAll(cfg)
  const target = skills.find((s) => s.name === name)
  if (!target) return { ok: false, status: 'notFound' }
  const state = readState(cfg.skills.dir)
  state.disabled = enabled
    ? state.disabled.filter((n) => n !== name)
    : [...new Set([...state.disabled, name])]
  if (!writeState(cfg.skills.dir, state)) {
    // 没落盘（状态损坏被拒写/写入异常）：明确告知调用方，不谎报"修改成功"
    return { ok: false, status: 'notPersisted' }
  }
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
