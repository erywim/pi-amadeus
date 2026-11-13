# 自动化任务（Automations）

参考常见的自动化任务设计：由**服务端调度器**在定时、文件变化或 Webhook 事件发生时
发起一个真实 agent 回合，把用户写好的指令交给同一套模型、工具、记忆与人格，结果落在独立会话里。
页面关掉不影响执行；执行记录就是那条会话的消息。

## 1. 触发方式

| trigger | 配置 | 触发条件 |
| --- | --- | --- |
| `schedule` | `interval` / `daily` / `once` | 按 `next_run_at` 定时 |
| `file` | `watchPath`（文件或目录）、`debounceSeconds`（1~300） | `fs.watch` 变化，防抖后触发 |
| `webhook` | 自动生成或自定义 `webhookSecret` | `POST /api/automations/:id/trigger` |

定时子类型：

| 类型 | 配置 | 下次触发 |
| --- | --- | --- |
| `interval` | 间隔分钟数（5 ~ 10080） | 创建/上次完成后 + N 分钟 |
| `daily` | 本地时间 `HH:MM` | 下一个该时刻（今天已过则明天） |
| `once` | 绝对时间戳 `runAt` | 该时间；跑完自动停用 |

- 调度器每 **15 秒**查一次 `enabled = 1 AND trigger_kind = 'schedule' AND next_run_at <= now` 的任务。
- 文件触发器只在任务启用时挂载；路径/防抖变化会重启 watcher；监听失败写 `last_error`。
- 任务开始前先在数据库把 `last_status` 置为 `running`，同一任务不会因 tick 重入；
  大脑重启时会把残留的 `running` 恢复成 `error` 并把下次时间提前到当前，避免任务永远不再触发。
- 一个任务失败只影响它自己；错误写进 `last_error`，下次照常触发。
- 手动「立即运行」即使任务停用也允许跑一次，且不改变既定的下次触发时间。
- Webhook 触发需要 `x-amadeus-secret`（配置了密钥时）；触发内容会作为「[触发事件] …」追加到指令后。
- 文件/Webhook 任务没有 `nextRunAt`，界面展示 `lastTrigger`（如 `文件变化：change:foo.txt`）。

## 2. 一次运行的完整路径

```
scheduler.tick / runNow
  → markAutomationRunning（防重入）
  → runAgentTurn（channel = automation，sessionId = automation-<id>）
  → finishTurn（消息落库 + 记忆提取 + 好感度）
  → recordTurnMetric（看板渠道 = 自动化）
  → finishAutomationRun（状态 / 结果 / 错误 / 下次时间）
```

- **独立会话**：每个任务固定 `automation-<id>`，在桌面端会话列表里能打开继续聊。
- **真实结果**：`last_result` 是最近一次成功回合的正文（上限 8000 字），不是占位文本。
- **指标**：`turn_metrics.channel = 'automation'`，看板渠道分布与 token 统计都会包含。
- **记忆/好感度**：与手动聊天一样会触发记忆提取与好感事件。

## 3. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/automations?userId=` | 列表（含下次/上次时间、状态、结果） |
| POST | `/api/automations` | 创建；启用时立即算出 `nextRunAt` |
| PATCH | `/api/automations/:id` | 改名/改指令/改调度/启停；调度字段变化会重算下次时间 |
| DELETE | `/api/automations/:id` | 删除任务（保留它的历史会话） |
| POST | `/api/automations/:id/run` | 立即运行，202；界面轮询状态 |
| POST | `/api/automations/:id/trigger` | Webhook 触发（密钥头 `x-amadeus-secret`），202 |
| GET | `/api/automations/:id/messages` | 运行记录（该任务会话的消息） |

校验：名称 ≤ 80 字、指令 ≤ 4000 字、间隔 5~10080 分钟、`once` 时间必须晚于当前；
文件路径必须存在且是文件/目录；防抖 1~300 秒。

## 4. 关键状态与约束

- `last_status`：`''`（未跑过）/ `running` / `success` / `error`。
  `running` 同时是防重入锁，手动运行遇到它会返回 409。
- `nextRunAt = null` 表示不再触发（停用或一次性已完成）；界面据此显示「从未运行」。
- 调度器只由 brain 进程持有；桌面端不本地计时，因此多开窗口不会重复触发。
- 删除任务不会删除 `automation-<id>` 会话：历史结果仍可回看，避免误删证据。
- Webhook 密钥是调用方凭据，但需要展示给用户复制；它是本机触发凭据，不是模型 API key。
- 任务运行超时上限 10 分钟（`AbortSignal.timeout`），不会永久占住 `running`。

## 5. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/automation.ts` | 任务/状态/输入类型 |
| `services/brain/src/automation/schedule.ts` | 下次触发时间计算（纯函数） |
| `services/brain/src/automation/scheduler.ts` | 15s tick、防重入、真实回合执行、写回结果 |
| `services/brain/src/routes/automations.ts` | CRUD / 立即运行 / Webhook 触发 / 运行记录 |
| `services/brain/src/db.ts` | `automations` 表、到期查询、文件任务查询 |
| `services/brain/src/index.ts` | 启动与退出时管理调度器生命周期 |
| `apps/desktop/src/renderer/src/features/automations/AutomationsPage.tsx` | 任务页 |
| `apps/desktop/src/renderer/src/stores/automationStore.ts` | 页面状态与轮询 |

## 6. 验证

```bash
# 终端 1：大脑
npm run dev:brain

# 终端 2：调度语义 + Webhook/文件触发 + 真实执行
node scripts/e2e-knowledge-automation.mjs
node scripts/e2e-automation-triggers.mjs

# 终端 3：桌面端页面
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-workspace.mjs
```

覆盖：停用任务不排期、立即运行→success、结果落独立会话、启用后写入下次时间、停用清空、
改间隔重算、过去的一次性时间与过短间隔被拒绝；Webhook 密钥校验/202/真实回合/lastTrigger；
文件写入触发真实回合；桌面端新建 Webhook 任务→运行→显示触发来源。
