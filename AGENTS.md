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
- `npm run e2e` — 全部 `scripts/e2e-*.mjs` 的回归套件（前置同上；前置不满足会直接报错，不会伪装成全过）
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
