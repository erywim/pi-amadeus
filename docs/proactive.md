# 主动问候（Proactive Greetings）

当用户长时间没有开口时，让角色用**真实记忆与好感度**主动发一条消息。
不是固定模板，也不是本机定时器伪造的「假在线」：消息由真实模型生成、真实落库，
并写入用户最近的桌面会话。

## 1. 触发条件

调度器每 60 秒遍历一次启用该功能的用户；以下条件全部满足才生成：

1. 当前本地时间在 `activeStart` ~ `activeEnd` 之间（支持跨午夜）。
2. 用户最后一次发消息距今 ≥ `minIdleMinutes`（默认 180）。
3. 今天已问候次数 < `maxPerDay`（默认 2）。
4. 距上一条主动问候 ≥ `minIdleMinutes`。
5. 没有同一用户的生成正在进行（内存防重入）。
6. 失败后 10 分钟内不重试（避免模型故障时刷屏）。

## 2. 生成与落库

```
proactive 调度器
  → 读取设置 / 最近用户消息时间 / 今日次数
  → resolveTarget（chat 路由组，含冷却/配额）
  → system prompt（角色 + 召回记忆 + 好感度阶段）
  → completeText（真实模型，maxTokens 220）
  → 追加到用户最近的桌面会话（没有则建 proactive-<userId>，标题「主动问候」）
  → 写入 proactive_greetings + last_greeted_at
```

- 问候是一条普通助手消息，没有伪造的用户消息；会话历史里能看到它。
- 「最近」指未归档 desktop 会话里 `updatedAt` 最新的一段，与列表的置顶优先顺序无关，
  不写入其它渠道或已归档会话。没有可用会话时新建「主动问候」；原 `proactive-<userId>` 已存在且归档时使用新 ID，不隐式恢复归档。
- 生成失败只写日志并短暂退避，不会改动 `last_greeted_at`，也不影响其它功能。
- 手动「立即问候」绕过时间窗/空闲检查（用于预览与 E2E），仍然使用真实模型。

## 3. 界面

- 设置 → 陪伴：开关、空闲分钟数、时间窗、每天次数、今日次数、最近一条问候、立即问候。
- 陪伴页每 15 秒轮询 `/api/proactive`；首次进入把已有问候记为已读，不重放历史；
  新问候到达时自动切到对应会话并刷新消息，同时弹一条提示。
- 会话列表/文本模式也能看到这条消息（它就是会话里的一条助手消息）。

## 4. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/proactive?userId=` | 设置 + 最近一条 + 今日次数 |
| PUT | `/api/proactive` | 保存开关/空闲/时间窗/次数 |
| POST | `/api/proactive/run` | 立即生成一条（真实模型） |

## 5. 数据与约束

- `proactive_settings`：按用户一行；默认关闭。
- `proactive_greetings`：每次成功生成一条，含会话与消息 id，可追溯。
- 不生成固定文案：模型调用失败就不发。
- 不修改记忆/好感度：问候不是一次用户互动，不会刷分。
- 没有真实用户消息的账号不会自动问候（`lastUserMessageAt` 为空直接跳过）。
- 时间是本机时区；跨午夜窗口按 `from > to` 处理。

## 6. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/proactive.ts` | 设置/问候/接口类型 |
| `services/brain/src/proactive/index.ts` | 条件判断、真实模型生成、落库、60s 调度 |
| `services/brain/src/routes/proactive.ts` | 设置 / 最新 / 立即生成 |
| `services/brain/src/db.ts` | `proactive_settings` / `proactive_greetings` |
| `apps/desktop/src/renderer/src/features/settings/ProactivePanel.tsx` | 设置面板 |
| `.../features/live2d/CompanionPage.tsx` | 15s 轮询并展示新问候 |
| `.../lib/api.ts` | `fetchProactive` / `saveProactive` / `runProactive` |

## 7. 验证

```bash
# 独立回归：旧置顶/新活动/已归档/其它渠道，使用临时 SQLite 与模型 mock
node scripts/e2e-regression-contracts.mjs

npm run dev:brain
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 后端：触发条件、真实生成、落库
node scripts/e2e-automation-triggers.mjs

# 桌面端：设置保存、立即问候、陪伴页轮询显示
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-ui-extras.mjs
```

覆盖：设置保存、真实模型生成、消息落进最近会话、今日次数、陪伴页轮询自动显示。
