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
| `services/brain/src/workflow/types.ts` | meta / 结果 / 档位上限 / 进度事件 / 宿主钩子签名 |
| `services/brain/src/workflow/errors.ts` | `WorkflowError` / `WorkflowAbortedError` / `ScriptError`（引擎与沙箱通信层共用） |
| `services/brain/src/workflow/script.ts` | 解析 `export const meta`（纯字面量校验）、静态禁用项、在主线程侧驱动 worker 沙箱 |
| `services/brain/src/workflow/sandbox.ts` | **沙箱本体**（worker 线程入口）：vm 上下文 + 字符串桥 + 脚本内 `agent/parallel/pipeline/phase/log` 实现 |
| `services/brain/src/workflow/engine.ts` | `runWorkflow()`：信号量、预算、重试、统计 |
| `services/brain/src/workflow/agent.ts` | 子代理策略：只读工具、回合上限、结构化输出抽取与校验；复用 `turn/agent-executor.ts` 与 `turn/tool-chain.ts` |
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

## 5. 安全边界（沙箱怎么做、做到什么程度）

脚本由模型生成，所以按"不可信代码"执行。分四层：

1. **独立 worker 线程**：脚本不在主线程跑，超时/取消时主线程直接 `worker.terminate()`。
   同步死循环（vm 的 `timeout` 管）和 `await` 之后的死循环（vm 管不到）都能真正停下。
   worker 以**空 env** 启动——沙箱线程里即便拿到 `process` 也看不到 LLM 密钥等环境变量。
2. **vm 上下文里没有任何宿主对象**：`JSON` / `Math` / `Date` / `Array` / `Promise` 全是
   vm 自己 realm 的内建对象。这一点是关键——只要往 vm 里塞过一个宿主对象（哪怕只是
   `JSON`），脚本就能用 `obj.constructor.constructor('return process')()` 逃逸。
3. **字符串桥**：脚本与宿主之间只传 JSON 字符串（原语）。宿主函数被 bootstrap 的闭包
   捕获后立即从全局删除，脚本拿不到它的引用；宿主回传的也是字符串，不会产生宿主对象。
4. **`codeGeneration: { strings: false, wasm: false }`**：脚本自己的 `Function` / `eval`
   被禁用。`parallel` / `pipeline` 也实现在沙箱内部（它们的返回值必须是沙箱 realm 的
   数组，不能由宿主返回）。

其它约束：
- 子代理**没有 bash**：工作流没有用户确认通道，给命令执行等于绕过确认。
- 子代理**没有 workflow 工具**：禁止递归工作流。
- 动态 `import()` 与多余 `export` 在解析阶段就被拒绝。

**它不是安全容器。** 沙箱与主进程共用同一个 Node 二进制，防御的是"模型写的脚本意外或
恶意地拿到宿主能力"。如果 V8 / Node 的 vm 本身出现逃逸漏洞，这一层挡不住；需要更强保证
时应当换成独立进程 + 容器级隔离。当前定位是本地桌面应用：最坏情况仍是用户自己的机器，
风险面从"任意代码执行"收敛到"沙箱实现漏洞"。

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
超过档位子代理上限时明确失败；**沙箱逃逸回归**（脚本看不到 `process`/`require`，
`agent/parallel/args/JSON` 四条 `constructor` 链全部 `EvalError`）。

自证"缺了会挂"：把 `agentTurn.ts` 里注册 workflow 工具的那行条件改成 `false` 再跑，
B/C/D/E/F 五项必须失败。

沙箱本身的两项人工验证（不进回归套件，因为需要真实网络/长时运行）：

```bash
# 1) 逃逸探测：用真实 provider 跑两个并行子代理，确认引擎 + 沙箱 + 真实模型通路
#    （脚本见提交说明；核心断言：status=completed 且两个子代理都有输出）
# 2) 死循环终止：脚本 await 之后 while(true){}，signal 1.5s 超时，
#    必须在 1.5s 左右被 WorkflowAbortedError 终止且进程正常退出
```
