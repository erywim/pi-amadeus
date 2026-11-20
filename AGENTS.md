# 给编码 agent 的说明

本仓库的代码主要由 AI agent 编写、评审与提交。动手前请读完本文件。

## 仓库地图

| 位置 | 是什么 |
| --- | --- |
| `apps/desktop` | Electron 桌面端（electron-vite + React 19 + Live2D/pixi）。主进程、渲染进程、UI |
| `services/brain` | 大脑服务（Hono + pi-agent-core）：LLM、SSE、STT/TTS、会话、工具、skills |
| `packages/shared` | 两端共享的类型与工具 |
| `scripts/` | 开发期验证脚本：`e2e-*.mjs` 是 CDP 驱动的端到端验证（桌面端 dev 与 brain 运行中用），`dev.mjs` 同时拉起两端 |
| `docs/` | 需求与设计文档；`docs/code-standards.md` 是代码标准 |

## 常用命令

- `npm run typecheck` — 对全部 workspace 跑 `tsc --noEmit`（改代码后必须过）
- `npm run lint` — ESLint（提交前必须过）
- `npm run build` — 构建桌面端
- `npm run verify` — 依次跑 typecheck、lint、build（提交前一键全量检查）
- `node scripts/e2e.mjs [chat|voice|all]` — 桌面端 E2E（需 dev 已启动，端口 9222）
- 9222 被占用（如本机 Chrome 开着远程调试）时：`npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort <port>`，
  再用 `CDP_HTTP=http://127.0.0.1:<port>` 指给专项脚本；`BRAIN_URL` 同样可覆盖 Brain 地址。测试时用 `AMADEUS_USER_DATA_DIR=<隔离目录>` 启动桌面端，配合隔离 `DB_PATH`，不要连接用户真实 Chrome 或数据目录
- `npm run e2e` — 全部 `scripts/e2e-*.mjs` 的回归套件（前置同上；前置不满足会直接报错，不会伪装成全过）
- `node scripts/e2e-agents.mjs` / `node scripts/e2e-collaboration.mjs` — 自建隔离 Brain/SQLite/本地模拟模型，验证 Agent 任务与设备网关，不依赖用户真实凭证或已启动 dev
- `node scripts/e2e-tool-approval-abort.mjs` / `node scripts/e2e-agent-process-stop.mjs` — 等待审批取消与内置命令树停止回归
- `node scripts/e2e-model-dispatch.mjs` / `node scripts/e2e-turn-runtime.mjs` / `node scripts/e2e-turn-boundaries.mjs` — 模型调度、可替换执行器/工具链与取消收尾契约（无真实凭证/桌面前置）；边界见 `docs/turn-runtime.md`
- 其它专项 e2e 见 `scripts/e2e-*.mjs`（config / vision / tools / feishu / mic / skills …）

## 规则

- 写代码和评审代码，都以 [docs/code-standards.md](docs/code-standards.md) 为准。提交前逐条过一遍验收清单。
- 改代码之前，先读 [LESSONS.md](LESSONS.md)：之前修坏的、返工过的东西都在里面。
- 文档与代码同改：如果改动改变了 `docs/v1-requirements.md` 或设计文档描述的行为，同一个提交里更新文档。新增子系统设计文档放 `docs/`，并在文末附上可复制的验证命令。
- e2e 脚本（`scripts/*.mjs`）是真实应用：它们启动真实桌面端、访问真实端口。别把测试数据写进用户的真实数据目录。

## 提交格式

- 主题：`<范围>: <用户能感知的行为变化>`（中文即可），范围如 `desktop` / `brain` / `shared` / `scripts` / `docs`。
- body 里写清：改了什么、跑了哪些验证（命令和结果）、没跑什么。
- 一个提交只做一件事；修 bug 的路上发现的新问题，单独提交。
