# 上下文压缩

参考 Claude Code 的压缩策略（`src/services/compact/` 的分层设计），按本项目的
"陪伴助手 + 工具"场景做了裁剪。目标：长会话不撞模型上下文上限，同时不丢用户信息、
不改变普通会话的行为。

## 1. 分层

| 层 | 触发 | 代价 | 做什么 |
| --- | --- | --- | --- |
| 会话级压缩（autoCompact） | 历史估算 token 超过档位阈值 | 一次或多次 LLM 摘要请求 | 把"最近 N 条之前"的历史折叠成结构化摘要，摘要落库，之后只带摘要 + 边界之后的原文。**只作用于当前活动世界线**，见 `docs/worldline.md` |
| 回合内微压缩（microCompact） | 单回合工具循环把上下文撑过阈值 | 零 LLM 调用 | 只把**较早的工具结果**替换成一行占位说明，保留最近几条原文；用户消息与助手回复不动 |
| 兜底截断 | 关闭压缩档位 | 零 | 只取最近 40 条消息（旧行为） |

不做的事（与参考实现的差异，均为刻意取舍）：
- 不做跨会话/跨进程的 transcript 投影与 snip：本项目消息本来就存在 SQLite，直接按边界切片。
- 不做 prompt cache 共享的 fork 摘要：本项目未启用供应商侧 prompt cache。
- 不做 session memory 压缩：长期记忆是另一套子系统（见 `memory-and-providers.md`），
  它的召回结果逐回合进 system prompt，不参与历史摘要。

## 2. 真实源头文件

| 位置 | 职责 |
| --- | --- |
| `services/brain/src/context/limits.ts` | 上下文窗口、输入预算、两档策略参数（阈值比例、保留条数、分块大小） |
| `services/brain/src/context/tokens.ts` | token 估算（CJK 按字、其余按 3.5 字符/token，故意偏高） |
| `services/brain/src/context/prompt.ts` | 摘要提示词（`<analysis>` + `<summary>` 九小节）、摘要正文提取、注入包装 |
| `services/brain/src/context/compact.ts` | `buildHistory()`：读边界 → 判断阈值 → 迭代摘要 → 落库；连续失败熔断 |
| `services/brain/src/context/micro.ts` | `microCompactMessages()`：回合内工具结果微压缩 |
| `services/brain/src/conversation.ts` | `prepareTurn()` 调用 `buildHistory`，把摘要作为第一条 user 消息放进上下文 |
| `services/brain/src/agentTurn.ts` | 注入 `transformContext` 做微压缩；压缩发生时发 `compact` SSE 事件 |
| `services/brain/src/db.ts` | `session_compactions` 表与读写方法 |
| `packages/shared/src/config.ts` | `UserConfig.compaction.level`（`off` / `balanced` / `aggressive`） |
| `apps/desktop/.../features/settings/AiPanel.tsx` | 档位选择 UI |

## 3. 关键状态

- **压缩边界**（`session_compactions` 一行一个会话）：
  `summary`、`through_message_id`、`through_created_at`、`messages_summarized`、
  `tokens_before/after`、`updated_at`。
  边界表示"这条消息（含）之前的历史已被折叠"。下一回合只取边界之后的消息。
- **档位**：`off` 只按条数截断；`balanced`（缺省）在输入预算 72% 触发、保留最近 8 条；
  `aggressive` 在 55% 触发、保留最近 4 条。
- **连续失败计数**：进程内按会话记，连续 3 次摘要失败后停止尝试（成功一次清零）。

## 4. 运行时路径

```
POST /api/chat
  └─ runAgentTurn
       └─ prepareTurn
            ├─ buildHistory
            │    ├─ 读 session_compactions（边界）
            │    ├─ 取边界之后的消息（最多 200 条）
            │    ├─ 估算 token ≤ 阈值 → 原样返回（摘要 + 原文）
            │    └─ 超阈值 → 分块迭代摘要（旧摘要 + 新消息逐块合并）→ 写边界
            ├─ 摘要作为第一条 user 消息（"这是背景，不要回应"）
            └─ 追加本次用户消息
       ├─ 若发生压缩 → 推一条 compact SSE 事件（UI 记进工作卡）
       └─ Agent 循环内每次 LLM 调用前 transformContext：超 60%/45% 时微压缩旧工具结果
```

语音回合（`runVoiceTurn`）走同一个 `prepareTurn`，因此同样受压缩保护。

## 5. 不能违反的约束

1. **摘要失败 = 保留完整历史。** 摘要请求报错、超时、返回空，都退回未压缩的历史继续本回合，
   绝不写边界、绝不丢消息。
2. **边界找不到按时间兜底，再找不到就当没压缩过。** 消息被删（重新生成替换旧回复）时，
   `through_message_id` 可能不存在；此时用 `through_created_at` 定位。两条路都失败时返回全部历史
   （未知 ≠ 全部已摘要）。
3. **尾部永不动。** 只折叠"最近 N 条之前"的历史，保证重新生成依赖的"最后一条用户消息"仍在上下文末尾。
4. **摘要是一条带说明的 user 消息，不是 system prompt 的一部分。** 包装里写明"这是背景、不是新请求、
   不要回应或复述"，否则模型会对着摘要寒暄一遍。
5. **微压缩只动 `toolResult`。** 用户消息与助手回复一个字都不改；已经是占位符的跳过。
6. **摘要只属于一条世界线。** `listMessages` 只返回活动世界线，压缩不会把别的分支读进来；
   世界线跳跃 / 回退 / 重新生成都会清掉摘要——换了世界线还沿用旧摘要，模型会"记得"没发生过的事。
   跨世界线保留的只有按用户存储的长期记忆（见 `docs/worldline.md`）。
6. **`transformContext` 绝不抛错。** 出错时原样返回消息数组（pi 的契约，抛错会打断整个 agent 循环）。

## 6. 怎么验证

```bash
# 无需真实 LLM / 无需启动桌面端：脚本自带假 LLM（OpenAI 兼容 SSE）+ 临时库 + 独立 brain 子进程
node scripts/e2e-context.mjs
```

覆盖：关闭档位只带最近 40 条；均衡档位触发摘要并把上下文换成"摘要 + 最近 8 条"（断言真正发给模型的
请求体里不再出现最早的消息）；边界持久化（第二回合不重复摘要）；摘要失败不破坏回合且保留全部历史；
回合内微压缩只替换旧工具结果。

自证"缺了会挂"：把 `COMPACTION_POLICIES.balanced.triggerRatio` 改成 99 再跑，B/C 两项必须失败；
把 `microCompactMessages` 改成直接返回入参，E 项必须失败。
