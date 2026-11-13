# 记忆、好感度与多模型服务

这一层借鉴了两个项目：

- [Shiori-Agent](https://github.com/YinFengWindy/Shiori-Agent)：角色中心的长期记忆、好感度与关系阶段
- [magpie](https://github.com/yetone/magpie)：多模型服务（Providers）与一键切换

一条硬规则贯穿全部实现：**只展示真实发生过的事**。没有聊过就没有记忆，没有互动就没有好感，
没有真实请求就没有 token 数字；产品里没有任何演示/种子数据。

## 1. 长期记忆

### 写入：回合结束后自动提取

每次成功回合（桌面文本/语音、飞书）结束后，`finishTurn` 在后台用**用户自己的模型**发一次小请求
（`memory/extract.ts`），从这一轮对话提取 0-3 条稳定事实：

- 只提取用户主动提供的长期信息：身份、偏好、习惯、重要事件、关系（人/宠物）
- 不提取寒暄、一次性情绪、助手自己的话、常识
- 与已有记忆做归一化去重（完全相同或互相包含都跳过）
- 模型没给出条目就不写；提取失败只打日志，不影响回合

### 读取：每回合召回并注入

`prepareTurn` 在组装 system prompt 前召回记忆（`memory/recall.ts`）：

- 置顶记忆永远带上（最多 4 条）
- 其余用「关键词命中 + 新近度」排序：中文按 2-gram、英文按词，命中越多越靠前，取前 8 条
- 被选中的记忆更新 `last_used_at`（记忆页会显示「上次使用」）
- 以「长期记忆」段落注入 system prompt，并明确要求自然使用、不要逐条复述

局限：没有 embedding，同义改写（「写代码」vs「编程」）召回不到。这是 v1 的已知取舍，
不是数据问题；后续可接语义检索。

### 管理

记忆页（`/memory`）支持搜索、手动新增、编辑、置顶、删除；所有操作直接读写大脑 SQLite。
手动新增是真实记录（用户自己写的），不是演示数据。

## 2. 好感度（Affinity）

好感度只由**真实互动事件**累计（`memory/affinity.ts`），每个成功回合记一次：

| 事件 | 分值 |
| --- | --- |
| 回合互动（基础） | +1 |
| 认真倾诉（用户消息 ≥ 20 字） | +1 |
| 深入交流（助手回复 ≥ 80 字） | +1 |
| 一起完成任务（本回合有工具调用） | +1 |
| 记住了一件事（本轮新增了记忆） | +2 |

阶段阈值（`AFFINITY_STAGES`）：陌生 0 / 认识 10 / 熟悉 30 / 亲近 60 / 喜欢 100 / 挚爱 180。
记忆页展示当前分数、阶段、距下一阶段的分差、最近 14 天累计曲线与最近互动事件。
文本侧栏底部也会显示关系读数，回合结束后自动刷新。

重新生成会再记一次互动（确实又发生了一轮生成）；如果不想让它加分，后续可给 regenerate 传标记。

## 3. 多模型服务

### 解析顺序

`resolveTarget`（`conversation.ts`）按以下顺序取模型：

1. `providers` 表里 **active + enabled** 且不在冷却中的服务
2. 激活服务冷却中时：按 `priority` 取下一个 **enabled + 有密钥 + 健康** 的服务（自动故障转移）
3. 所有服务都在冷却：仍回到激活服务（宁可再试一次，也不让用户突然没有模型）
4. 没有任何激活服务：用户配置里的单条内置配置（设置 → AI 配置）
5. `.env` 默认（`LLM_BASE_URL` / `LLM_API_KEY` / `AI_MODEL`）

激活服务优先，所以设置页的内置配置标注为「仅在没有任何激活的模型服务时生效」。

### 故障转移（magpie 思路）

- 真实回合失败（连接错误、鉴权失败、返回为空）→ 该服务进入 **10 分钟冷却**；
  用户点「停止」不算故障。
- 冷却期内新的回合自动按 `priority` 换下一个健康服务；成功一次立即解除冷却。
- 连通性测试与真实回合共用同一份冷却状态：测试失败同样进入冷却，测试成功即解除。
- 冷却只存在内存：大脑重启后所有服务重新视为健康（持久化一个可能已恢复的故障状态更糟）。
- 服务列表回传 `coolingDown`，设置页显示「故障冷却」徽标。

仍未实现（与 magpie 的差距）：路由组 / 权重分流 / 配额查询。

### 管理

设置 → AI 配置顶部新增「模型服务」：

- 新增/编辑/删除；同一时间只有一个激活服务；每条服务可单独配代理
- 密钥只存服务端，列表只回传 `apiKeySet`；编辑时留空表示保持原密钥
- 「测试」会真的发一次最小补全请求，显示延迟与模型回显（失败展示真实错误）
- 输入框模型选择器在有激活服务时改的是该服务的模型，否则写回内置配置
- 每回合指标会记录服务名，看板的「模型服务用量」按服务聚合


## 4. 数据真实性

- **产品不含任何种子数据**：记忆、好感度、指标全部来自真实写入
- **token 不估算**：来自 pi-ai 每次调用的 `usage`；没有 usage 就记 0
- **渠道覆盖**：桌面文本、桌面语音、飞书回合都会落指标（`recordTurnMetric`）
- **不回溯**：指标从本功能上线后的回合开始记录；更早的历史不补造
- **提取成本**：每回合多一次小模型调用（约 200 token）；失败不影响对话

## 5. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/memory.ts` | 记忆/好感度类型、阶段阈值 |
| `packages/shared/src/provider.ts` | 模型服务类型（密钥不回传） |
| `services/brain/src/memory/extract.ts` | 回合后记忆提取（真实模型调用） |
| `services/brain/src/memory/recall.ts` | 关键词召回 + system prompt 注入 |
| `services/brain/src/memory/affinity.ts` | 好感度事件与汇总 |
| `services/brain/src/providers/registry.ts` | 服务 CRUD、激活、真实连通性测试、冷却状态回传 |
| `services/brain/src/providers/failover.ts` | 内存冷却表与故障标记（10 分钟） |
| `services/brain/src/routes/memories.ts` | `/api/memories*`、`/api/affinity` |
| `services/brain/src/routes/providers.ts` | `/api/providers*` |
| `services/brain/src/metrics.ts` | 回合指标落库（含 provider 名） |
| `services/brain/src/conversation.ts` | 记忆注入、目标解析、finishTurn 副作用 |
| `apps/desktop/src/renderer/src/features/memory/` | 记忆与关系页 |
| `.../features/settings/ProviderSection.tsx` | 模型服务管理 |
| `.../stores/memoryStore.ts` / `providerStore.ts` | 前端状态 |

## 6. 约束

- 记忆/好感度写操作失败只告警，不能影响回合完成。
- 服务密钥永远不出现在列表接口、日志与截图中；`.env` 已被 `.gitignore` 忽略。
- 召唤记忆时只注入当前用户的数据（`user_id` 过滤）。
- 好感度分值规则一旦上线就视为可解释契约；改规则需在文档里同步并说明是否重算历史。

## 7. 验证

```bash
# 终端 1：大脑（读取 services/brain/.env）
npm run dev:brain

# 终端 2：桌面端 dev（9222 被占用时换端口）
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 终端 3：记忆/好感度 + 模型服务 E2E
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-memory-providers.mjs

# 故障转移（真实 LLM + 失效端点，brain 级）
node scripts/e2e-knowledge-automation.mjs

# 回归
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-plugins.mjs
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-chat-assistant.mjs

npm run verify
```

`scripts/e2e-memory-providers.mjs` 覆盖：记忆新增/置顶/编辑/搜索/删除（与服务端对账）、
好感度页面读数与 `/api/affinity` 一致、模型服务新增/真实连通性测试/激活/编辑（密钥保留）/删除、
看板记忆与好感度与 `/api/stats` 一致。连通性测试默认指向本地 mock，可用
`E2E_PROVIDER_BASE_URL` / `E2E_PROVIDER_MODEL` / `E2E_PROVIDER_API_KEY` 指向真实服务；
端点不可用时该步输出 `not run`，不伪装通过。

`scripts/e2e-knowledge-automation.mjs` 的故障转移段：创建一个不可达服务（priority 1）与一个真实服务
（priority 2），激活前者 → 回合报错且服务进入冷却 → 下一回合自动改用真实服务并成功 →
指标记录实际使用的服务 → 连通性测试结果与冷却状态一致。没有真实 `.env` 时该段输出 `not run`。
