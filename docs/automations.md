# 自动化任务（Automations）

参考常见的定时任务设计：到点后由**服务端调度器**发起一个
真实 agent 回合，把用户写好的指令交给同一套模型、工具、记忆与人格，结果落在独立会话里。
页面关掉不影响执行；执行记录就是那条会话的消息。

## 1. 调度语义

| 类型 | 配置 | 下次触发 |
| --- | --- | --- |
| `interval` | 间隔分钟数（5 ~ 10080） | 创建/上次完成后 + N 分钟 |
| `daily` | 本地时间 `HH:MM` | 下一个该时刻（今天已过则明天） |
| `once` | 绝对时间戳 `runAt` | 该时间；跑完自动停用 |

- 调度器每 **15 秒**查一次 `enabled = 1 AND next_run_at <= now` 的任务。
- 任务开始前先在数据库把 `last_status` 置为 `running`，同一任务不会因 tick 重入；
  大脑重启时会把残留的 `running` 恢复成 `error` 并把下次时间提前到当前，避免任务永远不再触发。
- 一个任务失败只影响它自己；错误写进 `last_error`，下次照常触发。
- 手动「立即运行」不改变既定的下次触发时间，只更新上次状态与结果。

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
| GET | `/api/automations/:id/messages` | 运行记录（该任务会话的消息） |

校验：名称 ≤ 80 字、指令 ≤ 4000 字、间隔 5~10080 分钟、`once` 时间必须晚于当前。

## 4. 关键状态与约束

- `last_status`：`''`（未跑过）/ `running` / `success` / `error`。
  `running` 同时是防重入锁，手动运行遇到它会返回 409。
- `nextRunAt = null` 表示不再触发（停用或一次性已完成）；界面据此显示「从未运行」。
- 调度器只由 brain 进程持有；桌面端不本地计时，因此多开窗口不会重复触发。
- 删除任务不会删除 `automation-<id>` 会话：历史结果仍可回看，避免误删证据。
- 任务运行超时上限 10 分钟（`AbortSignal.timeout`），不会永久占住 `running`。

## 5. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/automation.ts` | 任务/状态/输入类型 |
| `services/brain/src/automation/schedule.ts` | 下次触发时间计算（纯函数） |
| `services/brain/src/automation/scheduler.ts` | 15s tick、防重入、真实回合执行、写回结果 |
| `services/brain/src/routes/automations.ts` | CRUD / 立即运行 / 运行记录 |
| `services/brain/src/db.ts` | `automations` 表与到期查询 |
| `services/brain/src/index.ts` | 启动与退出时管理调度器生命周期 |
| `apps/desktop/src/renderer/src/features/automations/AutomationsPage.tsx` | 任务页 |
| `apps/desktop/src/renderer/src/stores/automationStore.ts` | 页面状态与轮询 |

## 6. 验证

```bash
# 终端 1：大脑
npm run dev:brain

# 终端 2：调度语义 + 真实执行
node scripts/e2e-knowledge-automation.mjs

# 终端 3：桌面端页面
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-workspace.mjs
```

覆盖：停用任务不排期、立即运行→success、结果落独立会话（用户+助手两条消息）、
启用后写入下次时间、停用清空、改间隔重算、过去的一次性时间与过短间隔被拒绝；
桌面端新建→运行→状态成功→展开真实结果。
