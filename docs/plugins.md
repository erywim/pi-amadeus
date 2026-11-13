# 插件中心与数据看板

参考常见的「万物皆插件」生态：
一个插件就是一份可安装、可启停的能力包。Amadeus 现在有四类插件、一个离线可用的内置目录、
一个能真实拉起本地 MCP 服务的运行时，以及一块记录回合指标的数据看板。

## 1. 四类插件

| kind | 是什么 | 安装落点 | 生效方式 |
| --- | --- | --- | --- |
| `skill` | `SKILL.md` 能力包（frontmatter + 正文） | 大脑 `skills` 目录下的 `<id>/SKILL.md` | 每回合热加载，模型通过 `use_skill` 读取 |
| `prompt` | 快捷指令模板 | `plugins` 表的 `config.prompt` | 输入框「指令」菜单（或输入 `/`）插入正文 |
| `theme` | CSS 变量包 | `plugins` 表的 `config.vars` | 插件页「应用主题」立即写入 `body` 的 CSS 变量 |
| `mcp` | MCP 服务（stdio） | `plugins` 表的 `config.{command,args,env}` | 安装后拉起子进程，工具进入 agent 工具循环 |

### 生命周期

- **安装**：目录条目自带安装内容；MCP 类会向用户收集字段（目录、Token 等），随后立即尝试连接。
- **启停**：`plugins.enabled`。skill 的启停与文件里的 `.amadeus-state.json` 取并集——插件页关掉的
  skill 不再注入模型；MCP 停用会断开子进程；主题停用会回落到默认配色。
- **卸载**：删除插件记录；skill 会删掉由它创建的目录（只删 skills 目录内的路径），MCP 会断开进程。

安装记录在 SQLite `plugins` 表（全局，与 skills 目录同一层），不随用户切换。

## 2. 内置目录

`services/brain/src/plugins/catalog.ts` 是「发现」页的数据源，当前 24 条：

- **技能（8）**：代码审查、周报整理、会议纪要、论文速读、SQL 优化、需求文档、翻译润色、图表生成
- **指令（6）**：费曼式讲解、重构方案、竞品分析、旅行规划、面试模拟、提交信息
- **主题（4）**：命运石之门、纸月、深海、赛博青柠
- **MCP（6）**：文件系统、知识图谱记忆、结构化思考、GitHub、MCP 演示服务、网页抓取

目录离线可用（不依赖市场索引）；新增条目只改 `catalog.ts`，`id` 发布后不可改名。

## 3. MCP 运行时

`services/brain/src/mcp/client.ts` 是一个不依赖第三方 SDK 的最小实现：

- stdio 传输，一行一个 JSON-RPC 2.0 消息；只实现 `initialize` / `tools/list` / `tools/call`
- 超时：初始化 90s（npx 首次下载可能较慢）、列工具 20s、调用 180s
- 服务端 → 客户端的请求（sampling / roots）统一回 `-32601`，避免对方挂起
- stderr 保留尾部 4KB，进程退出/启动失败时作为错误信息返回给界面

`services/brain/src/mcp/manager.ts` 负责生命周期：

- `sync(specs)`：与已启用插件对齐——断开被移除/配置变化的服务，并行连接新服务；已退出的进程可按相同配置重连
- 一个服务起不来只影响它自己的状态（`status.error`），不阻塞回合；运行中退出立即移除其工具并转为错误状态
- 工具名带可读服务前缀与原始 `(serverId, toolName)` 的短稳定摘要（只保留字母数字下划线短横线，最长 64），
  避免长 custom id 截断、字符清洗或分隔符歧义造成重名；参数用 `Type.Unsafe(JSON Schema)` 原样透传给模型
- 结果文本截断到 8000 字符；图片块原样回传

启动时后台同步一次；安装/启停/自定义添加都会触发同步。`SIGINT/SIGTERM` 退出前先断开所有子进程。

### 安全边界

MCP 服务是**用户显式安装的本机子进程**，能力等同用户自己运行命令：

- 界面在添加自定义服务与安装 MCP 插件时都写明这一点
- MCP 的 `config.env` 原值只留在数据库与启动进程内；安装、列表、启停、重连及自定义添加响应统一返回 `{ 变量名: 是否已配置 }`，不回传值；详情 UI 仍可直接列键名
- 脚本不做任何来源校验——信任判断交给用户，与 DSH 生态的插件市场一致

## 4. 快捷指令

输入框工具行的「指令」按钮，或在空输入框输入 `/` 唤起菜单：

- 只列出**已启用**的 prompt 插件
- 支持键盘上下选择、Enter 选中、Esc 关闭
- 选中后模板正文写入输入框（不自动发送），用户可继续编辑

## 5. 主题

主题插件把一组 CSS 变量写到 `document.body.style`（内联样式优先级高于 `body.dark` /
`body.theme-amadeus` 的类规则），因此对全部页面生效。选择记在 localStorage
`amadeus_plugin_theme`，启动时由 `pluginStore.load()` 恢复；主题被停用/卸载时自动回落到默认。

## 6. 数据看板

指标表 `turn_metrics` 在每次**桌面文本**回合成功后写入一条（飞书渠道暂未接指标）：

- 会话/用户/渠道/模型、开始时间、耗时、工具调用次数与工具名、输入/输出/总 token
- token 来自 pi-ai 每次 LLM 调用的 `usage`；工具循环里的多次调用逐次累加
- 指标只从本版本开始记录，历史回合不回溯补造

`GET /api/stats?userId=&days=14` 返回：总量、按天序列（缺日补 0）、渠道分布、模型用量、工具 Top、插件统计。
前端用原生 SVG/CSS 画图（`features/dashboard/charts.tsx`），不引图表库。

## 7. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/plugin.ts` | 插件/目录/MCP 状态/看板类型 |
| `services/brain/src/plugins/catalog.ts` | 内置目录（24 条） |
| `services/brain/src/plugins/registry.ts` | 安装/卸载/启停/自定义 MCP/同步 |
| `services/brain/src/mcp/client.ts` | MCP stdio JSON-RPC 客户端 |
| `services/brain/src/mcp/manager.ts` | 连接生命周期 + AgentTool 包装 |
| `services/brain/src/routes/plugins.ts` | `/api/plugins*`、`/api/mcp/custom` |
| `services/brain/src/routes/stats.ts` | `/api/stats` |
| `services/brain/src/db.ts` | `plugins`、`turn_metrics` 表与查询 |
| `apps/desktop/src/renderer/src/stores/pluginStore.ts` | 插件状态、主题应用、快捷指令派生 |
| `.../features/plugins/` | 插件中心（发现/已安装/详情/自定义 MCP） |
| `.../features/dashboard/` | 数据看板与图表组件 |
| `.../features/chat/Composer.tsx` | 「指令」菜单与 `/` 触发 |

## 8. 约束

- **安装是显式动作**：不自动安装、不静默拉起进程；目录只提供安装内容。
- **一个服务失败不拖垮别的**：MCP 连接失败只写该插件状态，回合继续。
- **工具名冲突**：MCP 工具名带服务前缀；同名工具以先注册者为准（内置工具先于 MCP）。
- **不覆盖用户文件**：skill 安装前检查目标目录；卸载只删 skills 目录内的安装目录。
- **主题只改视觉**：变量限定以 `--` 开头的 CSS 自定义属性。
- **指标不伪造**：没有 usage 的回合记 0，不估算 token。

## 9. 验证

```bash
# 隔离隐私/MCP 契约：临时 SQLite、工作区与无网络 stdio mock；不需要启动应用
node scripts/e2e-privacy-contract.mjs

# 终端 1：大脑（DB_PATH 可指向临时库）
npm run dev:brain

# 终端 2：桌面端 dev（9222 被占用时换端口）
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 终端 3：插件中心 + 看板 E2E
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-plugins.mjs

# 回归：文本助手 E2E
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-chat-assistant.mjs

# 静态检查
npm run verify
```

`scripts/e2e-plugins.mjs` 覆盖：目录规模、类型过滤、标题搜索、prompt 安装、skill 安装/停用/卸载、
主题应用与恢复、看板 KPI 与服务端一致、六张图表卡、快捷指令菜单插入模板。
