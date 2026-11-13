# 后台 / 桌宠主动问候

应用挂在后台或进入桌宠模式后，每 **10 分钟 + 0~5 分钟随机**截一次当前桌面，交给
视觉模型判断用户在做什么，然后主动说 1~2 句话：系统通知 + 桌宠对话框 / 陪伴页展示，
并作为一条助手消息落进当前会话，用户回来可以接着聊。

参考实现：Open-LLM-VTuber 的 proactive speak（`prompts/utils/proactive_speak_prompt.txt`
+ `ai-speak-signal`）——它把"主动开口"建模成一条**不写进历史与记忆**的合成输入，
模型照常回复。本项目沿用这个思路（合成输入不落库），并按本 issue 的要求把触发条件
从"前端按钮"换成"后台/桌宠 + 10~15 分钟定时 + 桌面截图"。

## 1. 行为

- **触发条件**：桌宠模式；或主窗口在后台（不可见 / 最小化 / 失焦）。
  前台不截屏、不请求。
- **节奏**：刚进入后台起算 10 分钟 + 0~5 分钟随机；每次问候后重新抽。
  回到前台立即清掉到期时刻，下次进入后台从头起算，不会一进后台就弹一条。
- **不打断**：麦克风开着、语音回合或文本流进行中时顺延 1 分钟再看。
- **截图**：当前光标所在显示器，长边缩到 1280px、JPEG 质量 70（约 100~300KB）。
  macOS 需要「屏幕录制」权限，未授权时跳过并顺延 5 分钟（不会反复弹系统授权）；
  用户在设置页打开开关时才会主动触发一次授权。
- **生成**：`POST /api/proactive`，视觉模型按人格说 1~2 句中文，首行可带
  `【情】<情绪>`。模型不支持图像输入时直接 422，不退化成长篇随机搭话。
- **投递**：系统通知（`Amadeus` 标题，点击回到当前模式的窗口）+ 主进程把问候推给
  两个渲染层。桌宠窗口的对话框重新出现（即便上一轮被手动收起）并切换表情；
  主窗口弹 toast。问候同时已落库，回来能在会话里看到。
- **落库**：只有她说的那句助手消息进库；截图与"系统提示"这条合成用户消息都不落库。
  主动问候不触发记忆提取 / 好感度——那些只由真实用户回合产生。
- **开关**：设置 → 通用 →「后台主动问候」，默认开，本地持久化（`amadeus_settings`）。

## 2. 代码结构

| 位置 | 职责 |
|---|---|
| `apps/desktop/src/main/proactive.ts` | `ProactiveWatcher`：后台判定、10~15 分钟随机调度、`desktopCapturer` 截屏、请求大脑、系统通知、广播 `proactive:message`；`screenPermission` / `requestScreenPermission` |
| `apps/desktop/src/main/ipc.ts` | `proactive:config`（渲染层上报开关/身份/会话/忙碌）、`proactive:permission`、`proactive:request-permission` |
| `apps/desktop/src/main/window-manager.ts` | `isMainWindowBackgrounded()`（不可见/最小化/失焦）、`listWindows()`（广播目标） |
| `apps/desktop/src/preload/index.ts` | `window.api.proactive`：`setConfig` / `permission` / `requestPermission` / `onMessage` |
| `apps/desktop/src/renderer/src/lib/proactive.ts` | 渲染层接线：上报配置（去重）、收到问候写对话文本 / 切表情 / 刷新会话 |
| `apps/desktop/src/renderer/src/stores/settingsStore.ts` | `proactiveEnabled`（本地持久化偏好） |
| `apps/desktop/src/renderer/src/features/pet/PetDialog.tsx` | 收到问候时把对话框当成新的一轮重新打开 |
| `services/brain/src/proactive.ts` | 会话选择、视觉能力门控、提示词、情绪/正文解析、落库与指标 |
| `services/brain/src/routes/proactive.ts` | `POST /api/proactive { userId, sessionId?, frame }` |
| `services/brain/src/frames.ts` | 摄像头帧与桌面截图共用的 base64/大小校验 |
| `packages/shared/src/proactive.ts` | `ProactiveGreeting` / `ProactiveMessageEvent` 跨端类型 |

## 3. 关键约束

- **调度必须在主进程**：隐藏/后台渲染层的定时器会被 Chromium 节流；桌宠模式下主窗口
  已被隐藏，任何"跑在某个窗口里"的定时器都会随模式切换消失。截屏也只有主进程的
  `desktopCapturer` 能拿到（不需要用户每次选窗口）。
- **截图是隐私数据**：只出现在一次请求里，不落库、不写日志、不回显。发给模型服务的
  只有这张截图 + 一条固定指令；body 里不额外附带会话内容之外的东西。
- **只推助手消息**：合成输入不落库——否则聊天记录里会出现一条用户没发过的消息。
  这一点与 Open-LLM-VTuber 的 `skip_history` 口径一致。
- **模型能力门控**：`supportsVision(model)` 为假时 422（错误码 `no_vision`），
  不去请求、不建会话。纯文本模型收到 image 块会直接 400。
- **会话归属**：带了 `sessionId` 就必须存在且属于该 `userId`，否则 404；不带则接
  最近更新的会话，没有会话才新建。生成成功后才落库，失败不留空会话。
- **不打断对话**：忙碌状态由渲染层上报（麦克风 / 语音回合 / 文本流），主进程到点
  先看 busy，忙则顺延 1 分钟。
- **e2e 钩子只在 dev**：`window.api.debug.proactive`（注入帧 / 模拟后台 / 指定
  brain / 立即触发 / 读状态）与现有 `debug:*` 一样只在非打包构建注册。

## 4. 验证

```bash
# 终端 1：brain + 桌面端 dev（9222 被占用时换端口，下同）
npm run dev:all

# 终端 2（桌面端已登录后）
CDP_HTTP=http://127.0.0.1:9222 node scripts/e2e-proactive.mjs
```

`scripts/e2e-proactive.mjs` 自起一个 hermetic brain（临时 `DB_PATH`）+ 本地 OpenAI 兼容
stub LLM，不碰真实会话库、不消耗真实模型额度，覆盖：

- 大脑契约：缺字段 / 非法 base64 / 超限帧 → 400；纯文本模型 → 422 且不建会话；
  视觉模型 → 200 且`【情】`被解析、正文落库为唯一一条助手消息、截图不进库；
  同一会话第二次问候能看到上一轮历史；拿别人的 sessionId → 404。
- 桌面调度（CDP + `debug.proactive`）：前台 / busy / 开关关闭都不发请求；
  后台触发一次 → 大脑收到带 `image_url` 的请求、渲染层 `dialogText` 与
  `proactiveSeq` 更新、系统通知计数 +1、`nextDueAt` 落在 10~15 分钟；
  大脑不可达 → `failed` 且记录原因。
- 真实截屏：仅当系统已授予屏幕录制权限时跑；否则明确输出 `not run`，不伪装通过。
