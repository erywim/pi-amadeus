# 模型调度、回合状态与工具链的边界

PIAM-11 采用方案 A：仍在现有 Brain 内运行，保留聊天/语音/平台/工作台 API、SSE 字段与数据库结构，不另建服务，也不替换 pi-agent-core。

## 职责与真实源头

| 模块 | 唯一职责 | 不负责 |
| --- | --- | --- |
| [runtime/model-dispatcher.ts](../services/brain/src/runtime/model-dispatcher.ts) 的 `resolveTarget` | 按用途、激活服务、标签、冷却、配额决定目标 | 创建 Agent、装工具、更新回合状态 |
| [runtime/contracts.ts](../services/brain/src/runtime/contracts.ts) 的 `LlmTarget` / `ModelRuntime` | 目标与执行入口的内部类型契约 | HTTP/SSE 响应；target 含运行必需的密钥，不能直接序列化给客户端 |
| [llm.ts](../services/brain/src/llm.ts) 的 `createModelRuntime` / `streamText` | pi-ai 协议、参数、鉴权与预算适配 | 读取会话、选择服务、工具权限 |
| [conversation.ts](../services/brain/src/conversation.ts) 的 `prepareTurn` / `finishTurn` | 上下文、记忆、分支和消息持久化；语音保留无工具路径 | Agent 工具循环、工具装配 |
| [turn/tool-chain.ts](../services/brain/src/turn/tool-chain.ts) 的 `createToolChain` | 渠道/能力门控、skills、MCP、扩展工具、审批、安全检查与清理 | 选择模型或迁移状态；工作流作为扩展注入，不反向导入工作流引擎 |
| [turn/agent-executor.ts](../services/brain/src/turn/agent-executor.ts) 的 `executeAgent` | 消费已选 runtime/messages/tools，驱动唯一一套 Agent 生命周期，返回完整内部事件与 usage | DB、配置读取、SSE 截断、装配工具 |
| [turn/state-machine.ts](../services/brain/src/turn/state-machine.ts) 的 `transitionTurn` | 无副作用回合状态迁移、并发审批与终态保护 | 模型 SDK、网络、工具执行或持久化 |
| [turn/sse-adapter.ts](../services/brain/src/turn/sse-adapter.ts) 的 `toSseEvent` | 内部事件 → 既有 SSE；只在展示边界截断工具摘要 | 改模型上下文、审批决策 |
| [agentTurn.ts](../services/brain/src/agentTurn.ts) 的 `runAgentTurn` | 上述模块的组合根、回合级资源所有权 | 模型路由规则、具体工具实现 |
| [http/proxy.ts](../services/brain/src/http/proxy.ts) 的 `proxyFetch` | 模型与工具复用的代理网络原语 | 导入任何模型/会话实现 |

旧 `llm.ts` 的类型、`supportsVision`、`proxyFetch` 导出，以及 `conversation.ts` 的 `resolveTarget` / `RoutePurpose` 导出继续兼容。工具注册表只拿 `vision` / `proxy`，不再拿完整模型目标；工具网络客户端也不通过 `llm.ts` 取得代理。

## 运行路径与状态

```text
桌面文本 / Feishu / 平台 / 自动化 / AgentManager
                       |
                  runAgentTurn
                       |
        prepareTurn -- resolveTarget（一次）
                       |
        createModelRuntime + createToolChain
                       |
                 executeAgent
                       |
       内部事件 -> transitionTurn -> toSseEvent
                       |
               原入口提交消息/指标

workflow/agent -> 同一 executeAgent + createToolChain（仅只读工具）
voice -> prepareTurn -> streamText -> 双语解析/TTS（不装工具）
```

状态为 `preparing → running ↔ waiting_approval → completed`；任意非终态可进入 `failed` / `cancelled`。审批集合按 toolCallId 保存，A 落定不能清掉并行的 B；全部落定才回到 running。失败、取消或完成后，迟到回执不能复活回合。

这是**回合**状态机，不替代 `AgentManager` 的 durable task 状态。工作台仍保留 `queued/running/waiting_approval/completed/failed/cancelled/interrupted`、并发槽、cwd 锁、持久化与重启策略，也仍消费兼容 SSE。自动化调度器的计划与排队策略不变。

## 不能违反的约束

- 每回合只调度一次：图片附件按 vision，语音视觉帧维持原 chat 能力门控。上下文摘要、正文和返回结果共用同一 target；语音落库/指标不再重新选服务。
- 任务模型覆盖在压缩和图片准备前应用，并重算视觉能力；不回写用户配置。服务标签/冷却/配额/内置回落策略不变。
- `ModelRuntime` 只是 model + streamFn；执行器可以用无 HTTP 的内存模型与自定义工具独立验证，不暗中调用全局模型。
- 主回合保留所有流式正文；子代理仍取最后一条非空正文、最多六轮、无 bash、无 MCP/skill/递归 workflow。
- 模型看到的工具结果保持完整；UI 摘要仍截断至 4000 字符。审批命令仍完整展示，超过 16 KiB 在登记审批前拒绝。
- 工具总开关关闭时不加载 skill/MCP/工作流，手册也不注入；computer 仍要求 desktop + vision + 用户开启。
- 取消信号传到模型、工具网络与审批；消费者提前关闭生成器时，也必须停止执行、拒绝审批/桌面等待并等待收尾。终态之前必须排空已产生的事件。
- 解耦不等于 OS 沙箱：bash/外部 MCP 继续受原权限约束；不新增绕过审批的模式。

## 验证与回退

新增确定性契约覆盖：单次调度/路由回落/模型覆盖、内存 runtime 可替换、并发审批与旧回执、工具矩阵、阻断/取消、完整结果与展示截断、提前关闭 HTTP。它们只访问临时 SQLite/目录和回环 mock，不读取真实密钥。

红绿证据：旧代码每回合 `listProviders` 两次（`2 !== 1`）；提前 `return()` 后模型 HTTP 仍运行（`false !== true`）；用模块加载钩子移除状态机终态 guard 后，测试报“终态 complete 不应被 approval_requested 复活”。恢复实现后同样行为断言通过。

未夹带原有问题：在任务起点 `a2b99437978477b3572a57a66752b55542d76b33` 上，模型运行契约已是 11/14（已存温度、Agent length、冷却）；附件契约已是 8/11（编辑缺 userMessageId、重新生成失败切叶、提交失败路径）。解耦补回准备阶段的 userMessageId 后附件契约为 10/11；重新生成失败叶回滚、温度/length/冷却策略需另外修复，不能把本次验证描述为全绿。额外运行的隐私契约为 57/58，MCP 名称截断/清洗碰撞（`4 !== 9`）也在该起点重现；本次不改变工具命名算法。

无数据迁移。回滚本次源文件与导入改动即可，不删除会话、凭证或任务表。真实桌面对话、STT/TTS 和外部 MCP 需要单独实测；隔离测试不能替代真实硬件/供应商验证。

可复制命令：

```sh
npm run verify
node scripts/e2e-model-dispatch.mjs
node scripts/e2e-turn-runtime.mjs
node scripts/e2e-turn-boundaries.mjs
node scripts/e2e-workflow.mjs
node scripts/e2e-agents.mjs
node scripts/e2e-collaboration.mjs
node scripts/e2e-tool-approval-abort.mjs
node scripts/e2e-agent-process-stop.mjs
node scripts/e2e-context.mjs
node scripts/e2e-worldline.mjs
node scripts/e2e-fetch-contract.mjs
node scripts/e2e-search-contract.mjs
node scripts/e2e-regression-contracts.mjs
# 以下保留既有失败，报告实际输出而非忽略：
node scripts/e2e-model-runtime-contract.mjs
node scripts/e2e-attachment-replay-contract.mjs
# 隔离桌面/Brain/CDP 已启动后：
npm run e2e
```
