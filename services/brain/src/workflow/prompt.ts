import type { WorkflowLevel } from '@pi-amadeus/shared'
import { workflowLimitsOf } from './types.ts'

/**
 * 工作流编排手册（对应参考实现 /ultracode 注入的 playbook）。
 * 只在档位开启时进入 system prompt：把脚本契约、可用钩子、档位上限和
 * 几条常用编排模式讲清楚，模型才写得对脚本。
 */
export function workflowPrompt(level: WorkflowLevel): string {
  const limits = workflowLimitsOf(level)
  if (!limits) return ''
  const tier = level === 'max' ? '大档' : '标准档'

  return `【动态工作流（${tier}）】
你可以调用 workflow 工具：写一段 JS 脚本编排多个子代理并行工作，适合需要拆解、并行调研、多角度交叉验证的复杂任务。
注意：只有在任务确实需要"多个独立子任务"时才用；简单问题直接回答，不要为了用工具而用。

脚本契约（写错会直接报错）：
- 脚本是 async 函数的函数体，不是 ESM 模块：不要 import，不要 TS 语法（类型标注 / interface / enum / as / 泛型）
- 第一行必须是纯字面量：export const meta = { name: '...', description: '...', phases: [{ title: '...' }] }
- 用 return 交出最终结果；这就是你会拿到的返回值

可用钩子（已注入，直接用）：
- await agent(prompt, opts?) → 文本，或给了 schema 时返回结构化对象；失败返回 null
  opts: { label, phase, schema (JSON Schema), maxTokens, allowedTools }
- await parallel([() => agent(...), ...]) → 等全部完成，按入参顺序返回数组，单项失败为 null
- await pipeline(items, 阶段1, 阶段2, ...) → 每项按顺序跑各阶段，阶段签名 (prev, item, index)；单项失败为 null
- phase(title) → 进度分组；log(message) → 打点
- args → workflow 工具入参里的 args

子代理能力：只读工具（时间、计算、天气、搜索），没有 bash，没有记忆，不知道用户是谁。
所以 prompt 必须自包含：把背景、要查什么、输出什么格式都写进去。

档位上限：本次运行最多 ${limits.maxAgents} 个子代理，默认并发 ${limits.defaultConcurrency}（上限 ${limits.maxConcurrency}）。
输出 token 预算 ${limits.maxOutputTokens}。接近上限时缩小任务规模，不要硬跑。

推荐写法：
- 并行调研：phase('调研') → const findings = await parallel(angles.map(a => () => agent(...)))
- 边查边写：pipeline(items, item => agent('查：' + item), (r, item) => agent('基于 ' + r + ' 写 ' + item))
- 交叉验证：先 agent 产出结论，再 parallel 让多个子代理分别挑错，最后按票数汇总
- 结构化输出：opts.schema 给 JSON Schema，子代理会被要求只输出符合 schema 的 JSON；校验不过会自动重试一次

脚本里不能做的事：读写文件、发网络请求、调用 Date.now() 之外的宿主能力（Date/Math/JSON 可用）。
需要外部信息一律通过 agent() 的子代理去查。`
}
