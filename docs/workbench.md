# Agent 工作台（GUI）

参考常见的并行 agent 工作区界面：
把「会话 / 阶段 / 工具活动 / 运行图 / 工件」放在同一屏，让一次任务从开始到交付都可追溯。
本项目只借鉴它的布局与交互语言，CSS / React 组件均为本仓库实现；没有复制其业务代码或素材。

入口：顶部「文本模式」（`/text`）。陪伴模式（Live2D）不受影响。

## 1. 布局

```
┌ 顶栏（全局导航 / 设置 / 当前模型）──────────────────────────────┐
│ Agent 工作台                                                    │
│ ├ 模型服务条（provider chips，点击切换真实服务）                 │
│ ├ 会话标题栏（重命名 / 渠道 / token 用量 / 右侧面板开关）         │
│ ├ 阶段管线（思考 → 工具 → 回复 → 完成，来自真实回合事件）         │
│ ├ 左侧会话栏 │ 中间消息列 + 输入区 │ 右侧面板（运行图/终端/工件） │
│ └ 底部状态条（工作区 / 会话数 / 轮次 / 生成状态 / 模型 / 时间）    │
└────────────────────────────────────────────────────────────────┘
```

- **模型服务条**：`providerStore` 里的每条服务一个 chip；点击即调用激活接口，
  选中状态与数据库一致，冷却中的服务带警告标记。
- **阶段管线**：`stream` 的实时状态驱动，不用假计时器：
  `think`（等待首字）→ `tool`（出现工具事件）→ `reply`（首个 delta）→ `done`（回合落库）。
- **右侧面板**：三个页签
  - 运行图：每个会话一条泳道，节点来自真实消息；当前会话逐条绘制，其它会话按服务端消息数绘制。
  - 终端：当前会话真实发生过的工具调用（历史回合来自 `workLogs`，流式中来自 `stream`）。
  - 工件：从助手消息提取 HTML / SVG / Mermaid 代码块，复用聊天里的沙箱预览。
- **底部状态条**：会话/轮次/生成状态/模型/时间，全部来自 store 与真实数据。

## 2. 视觉语言

- **色板**：白/浅灰画布、近黑正文、hairline 边框、低饱和蓝灰主色（`#526795`），
  分支色使用绯红 / 蓝 / 绿 / 琥珀 / 紫（`--lane-1..6`）。
  色板只作用在 `.agent-workbench` 内，不改变陪伴 / 记忆 / 设置页。
- **字阶**：11 / 12 / 14 / 15px 的紧凑层级，mono 用于 id、模型名、终端。
- **流动边框**：流式气泡挂一层 SVG 虚线描边（`RunningBorder`），回合结束即卸载；
  运行图的活动泳道用流动虚线，进行中节点脉冲。
- **动效边界**：全部尊重 `prefers-reduced-motion`；空闲没有帧循环。

## 3. 数据来源与约束

| 区域 | 真实来源 | 约束 |
| --- | --- | --- |
| 会话泳道 | `sessionStore.sessions`（含 `messageCount`） | 非当前会话只按消息数绘制，打开后才显示完整节点 |
| 节点 | 当前会话的 `messages` | 不伪造消息内容；工具小点来自 `workLogs` |
| 阶段 | `stream.streaming` / `draft` / `tools` / `activeSession` | 只有真实事件才能推进阶段 |
| 终端 | `workLogs` / `stream.tools` / `stoppedLogs` | 只显示本进程内记录到的工具活动；历史工具日志不落库 |
| 工件 | 助手消息里的围栏代码块 | 仅 html / svg / mermaid；沙箱 iframe / Mermaid strict |
| 模型条 | `providerStore.providers` | 点击即真实激活；失败弹真实错误 |
| 状态条 | 会话与回合计数 | 没有回合就显示 0 |

- **开关状态**：右侧面板默认展开，可收起；本轮不持久化（每次进入文本页恢复展开）。
- **工件自动切页**：在消息代码块上点「预览」会选中工件并切到「工件」页；关闭预览回到工件列表。
- **不冒充分支树**：本项目没有分支/合并数据，所以只画并行会话泳道，不画不存在的分支关系。
- **不冒充差异视图**：没有 diff 数据，右侧面板不提供 差异页签。

## 4. 代码地图

| 位置 | 职责 |
| --- | --- |
| `apps/desktop/src/renderer/src/features/chat/ChatPage.tsx` | 工作台三栏布局与面板开关 |
| `.../features/workbench/ProviderStrip.tsx` | 顶部模型服务 chips 与激活 |
| `.../features/workbench/StagePipeline.tsx` | 阶段管线（真实流式状态） |
| `.../features/workbench/RunGraph.tsx` | 会话泳道 / 节点 / 流光 / 图例 |
| `.../features/workbench/TerminalView.tsx` | 暗色工具终端 |
| `.../features/workbench/ArtifactsView.tsx` | 工件的提取、列表与预览入口 |
| `.../features/workbench/WorkbenchSidePanel.tsx` | 右侧面板页签与收起 |
| `.../features/workbench/WorkbenchStatusBar.tsx` | 底部状态条 |
| `.../features/chat/RunningBorder.tsx` | 流式气泡的流动边框 |
| `.../features/chat/ArtifactPanel.tsx` | 沙箱预览组件（`ArtifactView`） |
| `.../styles/index.css` | `.agent-workbench` 色板、流光/脉冲动画、reduced-motion |
| `.../i18n/locales/*.json` | `workbench.*` 文案 |

## 5. 验证

```bash
# 终端 1：大脑
npm run dev:brain

# 终端 2：桌面端 dev（本机 9222 被占用时换端口）
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 终端 3：工作台 GUI E2E
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-workbench.mjs

# 回归
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-workspace.mjs
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-chat-assistant.mjs
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-chat-stop.mjs
npm run verify
```

`scripts/e2e-workbench.mjs` 覆盖：工作台外壳、模型 chip 激活、多会话泳道、点击泳道切换、
真实 bash 回合中的阶段推进 / 流动边框 / 状态条、回合结束的完成态、终端命令与输出、
工件提取与沙箱预览、右侧面板收起/展开。所有断言基于真实 Electron 页面与真实模型回合。
