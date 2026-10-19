# 桌宠模式

角色以透明置顶窗口浮在桌面上（交互逻辑参考 XnneHangLab / Open-LLM-VTuber-Web 的 pet mode）。本文说明行为、代码结构、切换时序与验证方法。

## 1. 行为

- **进入**：陪伴模式舞台底栏的「桌宠模式」按钮，或托盘菜单「桌宠模式」。
- **退出**：托盘菜单「窗口模式」。
- **窗口**：铺满主窗口所在显示器的工作区（不盖菜单栏 / 任务栏），无边框、透明、置顶（`screen-saver` 层级，盖过普通窗口与全屏应用），不进任务栏。
- **鼠标穿透**：默认整窗穿透，桌面照常可点；光标移到角色身上（可见网格，不含发丝间、身侧的空白）才接收鼠标，移开即恢复穿透。托盘「鼠标穿透」可强制整窗穿透（每次进入桌宠时为关）。
- **角色**：按住拖动换位置（移动超过 5px，或按住超过 200ms 且有移动即为拖动），松手后记住位置，下次进入桌宠恢复；拖到窗口边缘时模型画布每个方向至少三成留在窗口里。点一下（200ms 内松开、移动不足 5px）戳她，随机播一个傲娇反应手势（与陪伴页舞台同一个池子），说话或语音回合进行中不打断。首次进入在右下角，身高约为工作区的一半。
- **对话框**：有对话时贴在角色头部一侧（朝屏幕中心），按 5Hz 跟随角色拖动；侧向放不下时挪到头顶或脚下，始终完整留在窗口内。显示用户气泡与按句切分的流式回复——新句淡入、上一句缩成一行，首字前显示打字点，回合进行中句尾有流式光标。底栏是状态灯与状态文案（与陪伴页 HUD 同一套键）、停止、静音语音播报、麦克风、收起。无对话且空闲时隐藏；最后一句后约 6 秒自动收起；手动收起后本轮不再出现，下一轮对话或再点一下角色时重新出现。光标在对话框上时窗口接收鼠标。
- **会话**：桌宠窗口接着最新会话继续；语音回合在桌宠窗口内运行（麦克风与播报都在这里），回到窗口模式时主窗口刷新当前会话，立刻能看到这轮对话。
- **主窗口**：进入时隐藏并停掉自己的麦克风 / 语音回合 / 摄像头（桌宠窗口接管），渲染循环随后台节流暂停；退出时恢复显示。
- **macOS**：桌宠期间在所有桌面空间可见、可浮在全屏应用之上；副作用是 Dock 图标隐藏，入口在菜单栏托盘。
- **多显示器**：窗口只覆盖一块显示器（macOS 每块显示器各自一个 Space，单窗口无法跨屏）。主窗口可见时取它所在的显示器，否则取光标所在的。
- **托盘**：窗口模式 / 桌宠模式（单选）、鼠标穿透（桌宠时）、显示、隐藏、退出。文案跟随界面语言（中 / 英 / 日）。

## 2. 代码结构

| 位置 | 职责 |
|---|---|
| `apps/desktop/src/main/window-manager.ts` | `WindowManager`：主窗口与桌宠窗口的创建、模式切换、就绪握手、显隐 |
| `apps/desktop/src/main/pet-pointer.ts` | `PetPointer`：光标轮询、穿透切换、强制穿透 |
| `apps/desktop/src/main/tray.ts` | `AppTray`：托盘图标与菜单（图标在 `apps/desktop/resources/`） |
| `apps/desktop/src/main/labels.ts` | 原生菜单文案（`setMenuLanguage` / `menuLabels`） |
| `apps/desktop/src/main/ipc.ts` | `mode:get` / `mode:set` / `pet:ready` / `pet:set-interactive` / `app:ui-language` |
| `apps/desktop/src/preload/index.ts` | `window.api` 的模式与桌宠接口；dev 构建额外暴露 `debug` |
| `apps/desktop/src/renderer/src/main.tsx` | 按 `?window=pet` 挂 `PetRoot`（不挂路由）或主应用 |
| `apps/desktop/src/renderer/src/features/pet/` | 桌宠窗口：`PetApp`（透明根 + 舞台）、`PetDialog`（贴头部一侧的对话框与底栏操作）、`sentences`（流式回复按句切分）、`placement`（默认摆放 / 边界限制 / 存取换算）、`usePetPassthrough`（命中 → 穿透，按住期间保持）、`usePetDrag`（点按 / 拖动判定） |
| `apps/desktop/src/renderer/src/stores/petStore.ts` | `pet_config`：角色位置（锚点占窗口宽高的比例）与缩放 |
| `apps/desktop/src/renderer/src/features/live2d/poke.ts` | 戳一戳的反应手势池与判定（陪伴页与桌宠共用） |
| `apps/desktop/src/renderer/src/lib/appMode.ts` | 主窗口进入桌宠时停掉语音 I/O |
| `Live2DEngine`（`placement: 'free'`） | 角色位置与缩放由 `setPlacement` 指定，不再居中于容器 |
| `Live2DEngine.hitTest` | 逐三角形命中检测：容器坐标是否落在可见网格上 |

## 3. 切换时序

进入（window → pet）：

1. `WindowManager.setMode('pet')`：创建隐藏的桌宠窗口（加载 `?window=pet`），向两个渲染层广播 `mode:changed`（主窗口据此停语音 I/O），托盘单选随之刷新。
2. 桌宠渲染层模型加载完 → 摆到默认位置 → 两帧后发 `pet:ready`。
3. 主进程收到 `pet:ready`（只认桌宠窗口自己的 webContents）：隐藏主窗口并恢复其后台节流 → macOS 设置全空间可见 → `showInactive()` 显示桌宠窗口（不抢焦点）。

退出（pet → window）：销毁桌宠窗口 → macOS 先 `app.dock.show()` 再显示主窗口 → 广播 `mode:changed`。

鼠标穿透（显示后开始，隐藏/退出时停止）：

1. `PetPointer` 约 60Hz 轮询 `screen.getCursorScreenPoint()`，坐标变化时把窗口内坐标推给渲染层（`pet:cursor`）。
2. 渲染层 `usePetPassthrough`：光标下是带 `data-pet-interactive` 的元素，或 `engine.hitTest` 命中 → 可交互；结果变化时发 `pet:set-interactive`。
3. 主进程 `setIgnoreMouseEvents(!(interactive && !forced), { forward: true })`。

不依赖穿透期间转发的 mousemove：macOS 上穿透窗口收不到可靠的移动事件，轮询让两个平台走同一条路径。命中检测与实际渲染像素对照：一致率约 98%、可见像素零漏判；误判集中在网格边缘超出贴图轮廓的几个像素。按网格包围盒判断（XnneHangLab 的 `isHitOnModel` 做法）一致率只有约 87%，发丝间和手臂旁的空白也会挡住桌面点击。

兜底：

- 15 秒内没收到 `pet:ready`（模型加载失败等）→ 自动退回窗口模式；模型加载报错时渲染层也会直接请求退回。
- 桌宠窗口被意外关闭（如 Windows 上 Alt+F4）→ 退回窗口模式；应用退出过程中不触发。
- 切换途中改主意（进入后立即退出）→ 未就绪的桌宠窗口直接销毁，不会再显示。

## 4. 约束

- 桌宠窗口只能在首帧画完后显示：先显示会闪一下空的透明窗口或缩放为 0 的角色。
- 进入桌宠时主窗口必须停掉麦克风与 TTS：被隐藏的窗口不能继续收音或说话。
- `?asset` 引用的 `resources/` 不会被复制进 `out/`，打包配置必须包含 `resources/**/*`（见 `electron-builder.yml`）。
- 渲染层传入主进程的参数一律按 `unknown` 校验（模式值、语言代码、可交互标志），`pet:set-interactive` 只认桌宠窗口自己的 webContents。
- 可交互的界面元素（对话框等）必须带 `data-pet-interactive`，否则光标在其上时窗口仍穿透、点不到。
- 拖动期间必须保持可交互（`usePetPassthrough` 返回的 `hold`）：拖得快时光标会先离开网格，若此时切回穿透，系统不再把鼠标事件交给窗口，拖动中断。
- `pet_config` 只由桌宠窗口写。若与主窗口共用 `live2d_config`，主窗口内存里的旧值会在它下次写入时覆盖桌宠刚存的位置。持久化层用 `createGuardedJsonStorage`：内容损坏时回落默认位置，损坏原文另存 `pet_config.bad-<时间>`。

## 5. 验证

```bash
# 终端 1：桌面端 dev（9222 被占用时换端口，下同）
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 终端 2：桌宠模式 E2E（不需要 brain）
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-pet.mjs
```

脚本覆盖：HUD 按钮进入、窗口状态（可见 / 置顶 / 铺满工作区 / 背景透明 / 主窗口隐藏 / 托盘单选）、主窗口语音状态复位、退出恢复、二次进出、切换途中立即切回、托盘文案跟随语言（测完按原始字节还原语言偏好）、按命中区域切换穿透、强制穿透、命中检测与渲染像素对照、拖动（按住期间拖出网格仍接收鼠标）、点按反应、边界限制、位置记忆与重进恢复、`pet_config` 损坏回落默认位置（测完按原始字节还原 `pet_config`）、对话框（无对话隐藏 / 贴头部一侧不盖脸 / 完整在窗口内 / 光标在其上接收鼠标 / 用户气泡 / 按句拆分与新句折叠 / 状态灯 / 静音与停止 / 收起后点角色重开 / 空闲自动隐藏 / 下一轮自动出现；对话内容用 dev 调试接口注入，不依赖 brain）。主进程状态经 dev 专用的 `window.api.debug.state()` 读取；光标用 `window.api.debug.petCursor()` 的覆盖坐标驱动，不移动真实鼠标。
