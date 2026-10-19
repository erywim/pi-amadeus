# 桌宠模式

角色以透明置顶窗口浮在桌面上（交互逻辑参考 XnneHangLab / Open-LLM-VTuber-Web 的 pet mode）。本文说明行为、代码结构、切换时序与验证方法。

## 1. 行为

- **进入**：陪伴模式舞台底栏的「桌宠模式」按钮，或托盘菜单「桌宠模式」。
- **退出**：托盘菜单「窗口模式」。
- **窗口**：铺满主窗口所在显示器的工作区（不盖菜单栏 / 任务栏），无边框、透明、置顶（`screen-saver` 层级，盖过普通窗口与全屏应用），不进任务栏；整窗鼠标穿透，桌面照常可点。
- **主窗口**：进入时隐藏并停掉自己的麦克风 / 语音回合 / 摄像头（桌宠窗口接管），渲染循环随后台节流暂停；退出时恢复显示。
- **macOS**：桌宠期间在所有桌面空间可见、可浮在全屏应用之上；副作用是 Dock 图标隐藏，入口在菜单栏托盘。
- **多显示器**：窗口只覆盖一块显示器（macOS 每块显示器各自一个 Space，单窗口无法跨屏）。主窗口可见时取它所在的显示器，否则取光标所在的。
- **托盘**：窗口模式 / 桌宠模式（单选）、显示、隐藏、退出。文案跟随界面语言（中 / 英 / 日）。

## 2. 代码结构

| 位置 | 职责 |
|---|---|
| `apps/desktop/src/main/window-manager.ts` | `WindowManager`：主窗口与桌宠窗口的创建、模式切换、就绪握手、显隐 |
| `apps/desktop/src/main/tray.ts` | `AppTray`：托盘图标与菜单（图标在 `apps/desktop/resources/`） |
| `apps/desktop/src/main/labels.ts` | 原生菜单文案（`setMenuLanguage` / `menuLabels`） |
| `apps/desktop/src/main/ipc.ts` | `mode:get` / `mode:set` / `pet:ready` / `app:ui-language` |
| `apps/desktop/src/preload/index.ts` | `window.api` 的模式与桌宠接口；dev 构建额外暴露 `debugState` |
| `apps/desktop/src/renderer/src/main.tsx` | 按 `?window=pet` 挂 `PetRoot`（不挂路由）或主应用 |
| `apps/desktop/src/renderer/src/features/pet/` | 桌宠窗口：`PetApp`（透明根 + 舞台）、`placement`（默认摆放） |
| `apps/desktop/src/renderer/src/lib/appMode.ts` | 主窗口进入桌宠时停掉语音 I/O |
| `Live2DEngine`（`placement: 'free'`） | 角色位置与缩放由 `setPlacement` 指定，不再居中于容器 |

## 3. 切换时序

进入（window → pet）：

1. `WindowManager.setMode('pet')`：创建隐藏的桌宠窗口（加载 `?window=pet`），向两个渲染层广播 `mode:changed`（主窗口据此停语音 I/O），托盘单选随之刷新。
2. 桌宠渲染层模型加载完 → 摆到默认位置 → 两帧后发 `pet:ready`。
3. 主进程收到 `pet:ready`（只认桌宠窗口自己的 webContents）：隐藏主窗口并恢复其后台节流 → macOS 设置全空间可见 → `showInactive()` 显示桌宠窗口（不抢焦点）。

退出（pet → window）：销毁桌宠窗口 → macOS 先 `app.dock.show()` 再显示主窗口 → 广播 `mode:changed`。

兜底：

- 15 秒内没收到 `pet:ready`（模型加载失败等）→ 自动退回窗口模式；模型加载报错时渲染层也会直接请求退回。
- 桌宠窗口被意外关闭（如 Windows 上 Alt+F4）→ 退回窗口模式；应用退出过程中不触发。
- 切换途中改主意（进入后立即退出）→ 未就绪的桌宠窗口直接销毁，不会再显示。

## 4. 约束

- 桌宠窗口只能在首帧画完后显示：先显示会闪一下空的透明窗口或缩放为 0 的角色。
- 进入桌宠时主窗口必须停掉麦克风与 TTS：被隐藏的窗口不能继续收音或说话。
- `?asset` 引用的 `resources/` 不会被复制进 `out/`，打包配置必须包含 `resources/**/*`（见 `electron-builder.yml`）。
- 渲染层传入主进程的参数一律按 `unknown` 校验（模式值、语言代码）。

## 5. 验证

```bash
# 终端 1：桌面端 dev（9222 被占用时换端口，下同）
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 终端 2：桌宠模式 E2E（不需要 brain）
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-pet.mjs
```

脚本覆盖：HUD 按钮进入、窗口状态（可见 / 置顶 / 铺满工作区 / 背景透明 / 主窗口隐藏 / 托盘单选）、主窗口语音状态复位、退出恢复、二次进出、切换途中立即切回、托盘文案跟随语言（测完按原始字节还原语言偏好）。主进程状态经 dev 专用的 `window.api.debugState()` 读取。
