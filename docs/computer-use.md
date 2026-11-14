# Computer Use

本项目复刻的是 OpenAI Computer Use 的动作词汇与“动作后观察”闭环，但不把 `openai/codex` 开源仓库的 `cua_repl` 误称为底层桌面驱动。Codex 公共源码主要提供 MCP/REPL 编排、访问策略、Guardian 审查、证据和历史展示；底层执行由连接的 helper/driver 负责。本实现的执行端是当前 Amadeus Electron 窗口。

## 职责与运行时路径

```text
视觉模型 → pi-agent-core AgentTool(computer)
         → services/brain/src/tools/desktop-bridge.ts
         → SSE computer_request
         → renderer 确认卡
         → preload → Electron main ComputerControl
         → capturePage / sendInputEvent / insertText
         → POST /api/desktop-result
         → image content 回到下一次模型请求
```

- `services/brain/src/tools/computer.ts`：校验并执行内置 Electron fallback 的单个动作，截图作为 pi 原生 image block 返回。
- `services/brain/src/plugins/catalog.ts`：提供显式安装的 Open Computer Use MCP 目录项；真实跨应用动作由外部 runtime 执行。
- `services/brain/src/tools/desktop-bridge.ts`：一次性 pending 请求、串行、超时和 Abort 清理。
- `services/brain/src/routes/desktop-result.ts`：只接受匹配 `turnId/toolCallId/requestId` 的回执。
- `apps/desktop/src/main/computer-control.ts`：只接受已登记的 Electron `WebContents`，不执行 shell/脚本，不控制其它应用。
- `apps/desktop/src/renderer/src/features/chat/ComputerConfirmCard.tsx`：每个截图或输入动作都需要用户确认。

## 动作和约束

动作名与 OpenAI 官方 SDK 一致：`click`、`double_click`、`drag`、`keypress`、`move`、`screenshot`、`scroll`、`type`、`wait`。当前版本限制：

- 只在 `desktop` 渠道、工具开关开启且模型被识别为视觉模型时注册；非视觉模型不收到 `computer` 工具。
- 坐标是当前 Electron 窗口截图的 CSS/viewport 坐标，不是全系统坐标；截图 `surface` 明确为 `window`。
- 每个动作串行执行；截图和输入动作都显示确认卡。
- 文本最多 2000 字符，按键最多 4 个且必须在白名单，拖拽最多 64 个点，截图结果最多约 8 MB。
- 截图不落库、不写普通日志、不进入会话历史；只作为当前 Agent 上下文的 image block 传给模型。
- SSE 断开、用户停止、窗口销毁或超时会清除 pending；迟到回执返回 404。
- 这是内置 fallback 的窗口级能力，不是 Codex Sky/native 全桌面能力；macOS Accessibility、其它应用、锁屏桌面和系统级快捷键不在 fallback 范围内。
- 安装并启用 `Open Computer Use` MCP 插件后，真实跨应用 Computer Use 由外部 `open-computer-use mcp` runtime 提供；它只在 desktop + vision + 用户显式开关下进入模型上下文，并且每个 MCP 动作都需要确认。插件未安装、未连接或权限不足时，fallback 仍可用。

## 官方协议依据

- [OpenAI Computer Use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [openai-node ComputerToolset](https://github.com/openai/openai-node/blob/v7.56.0/docs/computer.md)
- [openai-python computer actions](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/computer_action.py)
- [Codex computer-use config](https://github.com/openai/codex/blob/main/codex-rs/config/src/computer_use.rs)
- [Codex `cua_repl` recognition](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/mcp.rs)

## 验证

静态检查：

```bash
npm run typecheck
npm run lint
npm run build
```

启动 Electron dev 后运行窗口执行器专项：

```bash
CDP_HTTP=http://127.0.0.1:9222 node scripts/e2e-computer-use.mjs
```

脚本验证真实 Electron `window.api.computer` 截图、非法输入和坐标边界；未配置视觉模型时不伪装为真实 LLM computer loop 通过。完整回归可用 `npm run e2e`，但需要先启动 brain 与 Electron dev。
