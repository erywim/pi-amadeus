# 常见 agent 助手形态（文本模式）

Amadeus 有两种形态：Live2D 陪伴形态（陪伴页 / 桌宠）和文本形态（`/text`，常见的 agent 助手）。
两者共用**同一套会话与消息**，模式只是回合级属性。本文说明文本形态的调研结论、本轮采纳的范围、
代码落点与验证方式。

## 1. 调研：常见实现在做什么

2026-11-13 依据各项目官方 README / 文档整理，只记录与本项目相关的交互能力。

| 实现 | 形态 | 与本项目相关的共性能力 |
| --- | --- | --- |
| Claude Code Desktop | 桌面 agent 客户端 | 会话列表各自独立上下文；输入框工具行有环境 / 权限模式 / 模型选择；`+` 挂附件、skills、connectors；`@` 引用文件；运行中可继续输入纠偏；停止按钮；转录视图 Normal / Thinking / Verbose，工具调用默认折叠成摘要；改动用 diff 审阅 |
| Codex / ChatGPT Desktop | 桌面 agent 客户端 | 任务式会话（New chat）；侧栏按时间分组的会话；任务进行中可见工具/命令执行；审批与权限模式；错误与重试；模型选择器 |
| Cherry Studio | 开源桌面客户端 | 多助手/Agent（指令、工作区、模型、工具权限）；文件与命令、浏览器自动化；Skills 与 MCP；定时任务与消息渠道；多模型对比；Markdown / 代码高亮 / Mermaid；本地知识库；附件与文件库 |
| LibreChat | 开源自托管 | ChatGPT 风格 UI；Agent 管理；工具活动 / 推理 / 搜索统一展示；消息复制（富文本）；会话置顶；搜索全部消息；上下文用量；可恢复流（断线重连续传）；消息编辑与分支 |
| Open WebUI | 开源自托管 | 模型切换；工具/函数；知识库；以终端与计算机能力扩展成 agent harness |
| LobeChat | 开源 | Agent 市场；MCP / Skills；多 IM 接入；并行任务 |
| Jan | 开源桌面 | 本地模型 + 云模型统一；自定义助手；MCP；隐私优先 |
| AnythingLLM | 开源 | 工作区内 Agent；定时任务；技能自动选择；附件拖拽与引用来源 |
| Open-LLM-VTuber | Live2D 桌宠 + Web | **窗口模式 / 桌宠模式自由切换**（与本项目两种形态最接近）；聊天记录持久化与历史切换；表情映射；桌宠置顶、穿透、拖动；内心想法展示 |

提炼出的共同骨架（与实现无关）：

1. **会话是一等公民**：列表、按时间分组、新建、重命名、搜索、删除；会话拥有独立上下文。
2. **回合状态必须可见**：流式正文 + 工具调用摘要（默认折叠）+ 停止；失败要看见原因并可重试。
3. **消息可操作**：复制、重新生成（常见实现还有编辑后重发与分支，本轮不做）。
4. **输入区是工具行**：模型选择、附件/技能入口、发送↔停止一体。
5. **阅读不被打断**：用户上滚后暂停自动跟随，提供「回到底部」。
6. **权限与安全**：命令执行前确认（本项目已有 bash 确认卡）；工具结果截断后展示。

## 2. 本轮采纳的范围

| 能力 | 本轮 | 说明 |
| --- | --- | --- |
| 会话重命名 | ✅ | 标题栏铅笔或双击标题；只改标题，不刷新 `updated_at`（重命名不该把旧会话顶到最前）；未落库的空会话由服务端按当前身份补建 |
| 会话置顶 | ✅ | 侧栏悬停图钉；置顶会话单独成组排在按天分组之前，置顶不刷新 `updated_at` |
| 会话搜索 | ✅ | 侧栏按标题本地过滤；同时用 350ms 防抖请求 `/api/sessions/search` 搜正文，命中消息按会话列出（带片段） |
| 消息复制 | ✅ | 用户 / 助手消息均可复制；Markdown 代码块带语言标签与一键复制 |
| 重新生成 | ✅ | 只对最后一条助手回复；服务端定位最后一条用户消息重跑，**成功落库时才替换旧回复**，失败保留上一版 |
| 编辑后重发 | ✅ | 用户消息可内联编辑；服务端改写正文并截断该消息之后的全部消息，再跑一个回合。分支树（保留旧分支可切换）未做 |
| 失败可见 + 重试 | ✅ | SSE `error` 落到会话级错误卡（含重试/关闭），不再只打 console |
| 滚动跟随 | ✅ | 用户上滚后暂停自动跟随，出现「回到底部」；自己发消息时强制跟到底部 |
| 快捷键 | ✅ | `⌘/Ctrl+N` 新会话、`Esc` 停止生成 |
| 附件 / 图片输入 | ❌ | 后端文本回合尚无多模态入口（v1 视觉仅语音回合），保留占位 |
| 上下文用量 / token 统计 | ✅ | 标题栏显示本会话真实 `turn_metrics` 累计（输入/输出在 tooltip）；没有回合就不显示 |
| Artifacts / 代码执行预览 | ✅ | 助手代码块里的 `html` / `svg` / `mermaid` 可在右侧沙箱预览；HTML/SVG 走 `sandbox` iframe，Mermaid 本地渲染（动态加载，按需分包） |

## 3. 代码落点

| 位置 | 职责 |
| --- | --- |
| `apps/desktop/src/renderer/src/features/chat/ChatPage.tsx` | 文本形态页面与全局快捷键（新会话 / 停止） |
| `.../features/chat/SessionSidebar.tsx` | 按天分组、置顶分组、标题过滤 + 正文搜索、`⌘/Ctrl+K` 聚焦、删除 |
| `.../features/chat/CodexTitlebar.tsx` | 标题内联重命名（Enter / 失焦提交，Esc 取消）+ 会话 token 用量读数 |
| `.../features/chat/MessageList.tsx` | 流式区块、错误卡、滚动跟随与「回到底部」 |
| `.../features/chat/MessageBubble.tsx` | 消息复制、编辑后重发、最后一条助手回复的重新生成入口 |
| `.../features/chat/ArtifactPanel.tsx` | HTML / SVG / Mermaid 沙箱预览面板 |
| `.../features/chat/TurnErrorCard.tsx` | 回合失败卡（错误信息 + 重试 + 关闭） |
| `.../features/chat/Markdown.tsx` | Markdown 渲染、代码块复制与「预览」入口 |
| `.../stores/sessionStore.ts` | 回合事件消费（发送 / 重新生成 / 编辑重发共用）、`turnErrors`、`renameSession`、`togglePin`、`editMessage` |
| `apps/desktop/src/renderer/src/lib/api.ts` | `startRegenerate`、`startEditTurn`、`renameSessionApi`、`setSessionPinnedApi`、`searchMessagesApi`、`fetchSessionUsage` |
| `services/brain/src/routes/chat.ts` | `POST /api/chat/regenerate`、`POST /api/chat/edit` |
| `services/brain/src/routes/sessions.ts` | `PATCH /api/sessions/:id`（重命名 / 置顶 / 空会话补建）、`GET /api/sessions/search`、`GET /api/sessions/:id/usage` |
| `services/brain/src/conversation.ts` | `appendUserMessage` / `omitMessageId` / `replaceMessageId`：重新生成不重复写用户消息，成功后替换旧回复；用户消息 id 随 done 事件返回 |

## 4. 关键状态与约束

- **重新生成的三段语义**：旧助手回复既不进 LLM 上下文，也不在生成前删除；只有新回复成功落库时才替换。
  生成失败时旧回复仍在——用户不会因为一次重试丢掉上一版答案。
- **不重复用户消息**：重新生成传 `appendUserMessage: false`，历史末尾必须仍是那条用户消息，
  否则 `prepareTurn` 直接抛错（宁可失败，也不要给模型一个重复提问的上下文）。
- **流全局唯一**：`stream` 只有一个，展示与归档只认 `stream.sessionId`；切会话不串台。
- **错误按会话归档**：`turnErrors[sessionId]`，切走再回来仍在；发起新回合时清掉。
- **滚动跟随**：`atBottom` 由滚动位置驱动；程序触发的平滑滚动期间忽略「离开底部」判定，
  否则「回到底部」按钮会在滚动途中重新弹出。
- **重命名排序**：`renameSession` 只改 `title`；自动标题 `setSessionTitle` 仍会刷新 `updated_at`
  （自动标题发生在回合结束后，本来就该排到最前）。
- **空会话**：会话行是首条消息时懒创建的；对尚未落库的会话重命名或置顶时，服务端按 `userId` 补建，
  否则刚开的会话改名/置顶会 404。
- **本地消息 id**：发送时界面先插一条 `local-…` 临时消息；服务端在 `done` 事件里回传落库后的
  `userMessageId`，store 用真实 id 替换。否则紧接着「编辑后重发」会拿临时 id 去打服务端，得到 404。
- **编辑重发**：服务端先改写用户消息正文、再删除它之后的所有消息，然后以 `appendUserMessage: false`
  跑回合——截断发生在生成之前，模型失败时会话停在「等待回答」，可重试，不会留下半截旧分支。
- **工件沙箱**：HTML/SVG 走 `iframe sandbox`（允许脚本但**不给** `allow-same-origin`），
  Mermaid 用 `securityLevel: 'strict'` 本地渲染；模型输出永远不会进应用自身的 DOM。

## 5. 验证

```bash
# 终端 1：大脑（默认 3002；DB_PATH 可指向临时库，避免污染真实会话）
npm run dev:brain

# 终端 2：桌面端 dev（9222 被占用时换端口）
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 终端 3：本轮新增的 E2E（失败路径与成功路径都会跑，按本机 LLM 可用性自动切换）
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-chat-assistant.mjs

# 全量回归
npm run verify
```

`scripts/e2e-chat-assistant.mjs` 覆盖：失败回合的错误卡与重试（用户消息不重复）、成功后重新生成
（替换而非追加）、重命名（store / 侧栏 / 服务端一致且不动 `updated_at`）、标题搜索与 Esc 恢复、
消息与代码块复制（逐字断言剪贴板内容）、滚动跟随与「回到底部」。
LLM 不可用时成功路径明确输出 `not run`，不伪装通过；有真实 key 时失败路径同理。

`scripts/e2e-workspace.mjs` 覆盖本轮新增的聊天增强：置顶同步到服务端、真实回合后侧栏正文搜索、
标题栏 token 用量、编辑后重发（旧分支截断、服务端只剩一问一答）、HTML 工件在沙箱 iframe 中渲染、
Mermaid 渲染成 SVG。工件用例向页面 store 注入一条内存消息作为渲染夹具（不落库、脚本结束即随会话清理）。

文本模式现在采用 Agent 工作台布局（模型服务条 / 阶段管线 / 右侧运行图与终端 / 底部状态条）；
工件预览也移入右侧「工件」页签。设计与验证见 [workbench.md](workbench.md)。
