import { Hono } from 'hono'
import type { BrainConfig } from '../config.ts'
import { listSkills, setSkillEnabled } from '../skills/index.ts'

/** skill 管理：列表（含启停状态）/ 启停切换。文件形式（SKILL.md），状态持久化在目录内 */
export function skillRoutes(cfg: BrainConfig): Hono {
  const app = new Hono()

  app.get('/skills', async (c) => {
    const { dir, skills } = await listSkills(cfg)
    return c.json({ dir, skills })
  })

  app.put('/skills/:name/enabled', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
    const enabled = body?.enabled === true
    const result = await setSkillEnabled(cfg, c.req.param('name'), enabled)
    if (!result.ok) return c.json({ error: 'skill 不存在' }, 404)
    return c.json({ ok: true, skill: result.skill })
  })

  return app
}
