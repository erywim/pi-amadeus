# 动态工作流

参考 Claude Code 的 Workflow 子系统（`packages/workflow-engine/` + `src/workflow/`），
把它移植到本项目的 brain 服务：模型写一段 JS 脚本，用 `agent()` / `parallel()` /
`pipeline()` 编排多个子代理，引擎确定性地执行并把进度实时上屏。

与用户主对话的区别：工作流是**一次工具调用内**完成的同步过程，不是后台任务；
没有跨运行 journal 重放；子代理不注入人格与记忆。

## 1. 档位

`UserConfig.workflow.level`（设置页 → AI 配置 → 动态工作流）：

| 档位 | 工具注册 | 默认并发 | 并发上限 | 子代理上限 | 输出 token 预算 | 超时 |
| --- | --- | --- | --- | --- | --- | --- |
| `off`（缺省） | 否 | — | — | — | — | — |
| `standard` | 是 | 3 | 6 | 12 | 40k | 5 分钟 |
| `max` | 是 | 4 | 10 | 30 | 150k | 15 分钟 |

关闭时模型**完全看不到**这个工具，system prompt 里也不会注入编排手册——不是"看到了但被拒绝"。

## 2. 真实源头文件

| 位置 | 职责 |
| --- | --- |
| `services/brain/src/workflow/types.ts` | meta / 结果 / 档位上限 / 进度事件 / 钩子签名 |
| `services/brain/src/workflow/script.ts` | 解析 `export const meta`（纯字面量校验）、静态禁用项、`node:vm` 执行 |
| `services/brain/src/workflow/engine.ts` | `runWorkflow()`：信号量、预算、重试、parallel/pipeline 语义、统计 |
| `services/brain/src/workflow/agent.ts` | 子代理：只读工具、回合上限、结构化输出抽取与校验 |
| `services/brain/src/workflow/tool.ts` | `workflow` 工具定义：参数、进度节流、结果文本 |
| `services/brain/src/workflow/prompt.ts` | 档位开启时注入 system prompt 的编排手册 |
| `services/brain/src/agentTurn.ts` | 按档位注册工具、注入手册 |
| `packages/shared/src/config.ts` | `UserConfig.workflow.level` |

## 3. 脚本契约

```js
export const meta = { name: '调研', description: '多角度并行调研', phases: [{ title: '调研' }] }

phase('调研')
const findings = await parallel([
  () => agent('从技术角度调研 X', { label: '技术' }),
  () => agent('从市场角度调研 X', { label: '市场' })
])
return { findings }
```

- 脚本是 async 函数的函数体：**不是 ESM 模块**，不能 `import`，不能用 TS 语法
- `meta` 必须是纯字面量（在无全局的 vm 里求值，引用变量即报错）
- 用顶层 `return` 交出结果；返回值序列化后作为工具结果给模型（上限 12k 字符）
- 注入的钩子：`agent` / `parallel` / `pipeline` / `phase` / `log` / `args`
- 内置对象白名单：`JSON` / `Math` / `Date` / `Array` / `Object` / `String` / `Number` /
  `Boolean` / `Map` / `Set` / `Promise` / `Error` / `TypeError` / `console`

`agent(prompt, opts)` 的 opts：`{ label, phase, schema, maxTokens, allowedTools }`。
给了 `schema`（JSON Schema）时，子代理被要求只输出符合 schema 的 JSON，引擎用
TypeBox `Value.Check` 校验；不合格按失败处理并重试一次。

## 4. 执行语义（与参考实现一致）

- `parallel(thunks)`：屏障——等全部完成，结果按入参顺序；单项抛错降级为 `null`（取消除外）。
- `pipeline(items, ...stages)`：每项按顺序跑各阶段（`(prev, item, index)`），项与项之间**不设屏障**；
  某项某阶段抛错 → 该项为 `null` 且跳过其余阶段。
- `agent()` 失败（抛错 / 返回 dead）自动重试一次；取消不重试。
- 并发是每次运行的 FIFO 信号量：超出上限的 `agent()` 排队，不报错。
- 输出 token 预算只统计**成功**的子代理；预算耗尽后再调用会失败（在 parallel/pipeline 里降级为 `null`）。
- `phase()` 是全局可变状态；并发分支里推荐用 `agent(..., { phase })` 标注，避免互相覆盖。

## 5. 安全边界

- 脚本由用户自己的模型生成，但仍按最小权限执行：`node:vm` 独立上下文，不暴露
  `require` / `process` / `fetch` / `fs`；`codeGeneration.strings=false` 堵住 `Function` / `eval` 逃逸。
- 同步执行段有 5s vm 超时；异步整体由 `Promise.race` 式的 AbortSignal 超时兜底（档位决定时长）。
- 子代理**没有 bash**：工作流没有用户确认通道，给命令执行等于绕过确认。
- 子代理**没有 workflow 工具**：禁止递归工作流。
- 动态 import 与多余 export 在解析阶段就被拒绝。

## 6. 进度与 UI

不新增 SSE 词汇：引擎的进度事件在工具内被累积成文本，通过 `onUpdate` 触发既有的
`tool_update` 事件（400ms 节流），前端 `WorkProcessCard` 直接展示。最终 `tool_end`
带运行统计与脚本返回值。

## 7. 怎么验证

```bash
# 无需真实 LLM / 无需启动桌面端：脚本自带假 LLM（OpenAI 兼容 SSE）+ 临时库 + 独立 brain 子进程
node scripts/e2e-workflow.mjs
```

覆盖：关闭档位没有工具与手册；标准档位注入工具与手册；`parallel` 并发两个子代理且
返回值回到模型、子代理拿不到 bash；`schema` 结构化输出被校验；缺 meta 的错误回给模型；
超过档位子代理上限时明确失败。

自证"缺了会挂"：把 `agentTurn.ts` 里注册 workflow 工具的那行条件改成 `false` 再跑，
B/C/D/E/F 五项必须失败。
