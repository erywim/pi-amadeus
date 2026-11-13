# 通讯平台接入（Platforms）

参考常见的多平台接入思路：把「外部聊天平台」抽象成适配器，
所有平台共用同一套身份、会话、记忆、好感度与指标，桌面端能看到并继续这些对话。

当前支持五类适配器（飞书仍由 `.env` 配置，是内置渠道）：

| 类型 | 传输 | 典型用途 |
| --- | --- | --- |
| `telegram` | Bot API 长轮询（getUpdates / sendMessage） | 不需要公网地址，填 Bot Token 即用 |
| `onebot` | OneBot v11 正向 WebSocket | 接 NapCat / Lagrange 等 QQ 协议端 |
| `discord` | Gateway WebSocket（v10）+ REST | 填 Bot Token；需在 Developer Portal 开启 Message Content Intent |
| `slack` | Socket Mode WebSocket + Web API | 填 bot token（xoxb）与 app token（xapp），不需要公网回调地址 |
| `webhook` | 入站 HTTP + 出站 HTTP | 接自建桥接、n8n、企业微信机器人等任何 HTTP 服务 |

## 1. 共用管线

```
外部消息 → 适配器解析 → /bind 绑定？ → 解析用户 → 会话串行队列
        → runAgentTurn（与桌面/飞书同一套工具、人格、记忆）
        → finishTurn（落库 + 记忆提取 + 好感度） → 指标 → 适配器回复
```

- **会话 ID**：`<platformId>-<chatType>-<chatId>`，一个群/私聊一个会话，跨重启稳定。
- **串行**：同一会话的回合排队执行，平台连发多条不会让上下文交错。
- **记忆/好感度**：和桌面完全共享；绑定后写到同一个 Amadeus 用户身上。
- **指标**：`turn_metrics.channel = 平台类型`，看板渠道分布里能直接看到 Telegram / QQ / Discord / Slack / Webhook / 自动化。
- **桌面可见**：会话列表带渠道徽标，点开可以继续聊（平台只是入口之一）。

## 2. 身份绑定

- 未绑定：按 `<kind>-<externalUserId>` 自动建档（每个外部账号一个用户）。
- 已绑定：在平台里发 `/bind <绑定码>`（绑定码在「设置 → 飞书」生成），之后消息都记在该桌面用户名下。
  绑定后该会话的归属会转移到绑定用户，桌面端立刻能在列表里看到并继续。
- 群聊与私聊使用各自的会话；同一用户在不同群里的上下文互不串。

## 3. 适配器细节

### Telegram

- 启动时 `getMe` 校验 Token，状态里显示 `@botname`。
- `getUpdates` 长轮询（timeout 25s）；只处理文本消息，忽略 bot 自己与其他 bot。
- 回复按 4000 字分段发送；长轮询超时不算错误，网络失败进入 error 状态并 5s 后重试。
- 可配置 `baseUrl` 指向自建/测试端点（E2E 用它接本地 mock）。

### OneBot v11

- 正向 WebSocket 连接（`ws://host:port`），`access_token` 走查询参数。
- 处理 `post_type=message` 的私聊/群聊事件；文本取 message 段里的 text，兜底 `raw_message`。
- 回复发 `send_private_msg` / `send_group_msg`，按 echo 等待结果，失败抛真实错误。
- 断线 3s 自动重连；状态在 running/error 之间切换。

### Discord

- 启动时先 `GET /users/@me` 校验 Bot Token，再连 Gateway（默认 `wss://gateway.discord.gg/?v=10&encoding=json`）。
- 协议：HELLO(op 10) → IDENTIFY(op 2，intents = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT)
  → 心跳(op 1) / ACK(op 11)；`MESSAGE_CREATE` 事件进入管线。
- 回复走 REST `POST /channels/:id/messages`，按 1900 字分段，并带
  `allowed_mentions: { parse: [] }`——模型输出里的 `@everyone` 不会真的 ping 全群。
- 忽略所有 `author.bot`（含自己）的消息，避免回声；op 7 / op 9 与连接关闭都走同一套 3s 重连。
- 可配置 `gatewayUrl` / `apiBaseUrl` 指向本地 mock（E2E 用它验证完整协议链路）。

### Slack（Socket Mode）

- 启动时 `auth.test` 校验 bot token 并拿到 bot user id；`apps.connections.open`（app token）换取 WebSocket 地址。
- 收到 `events_api` 信封时**先回 `{ envelope_id }` ack** 再处理（Slack 3 秒内收不到 ack 会重投同一条事件）。
- 只处理 `event.type = message` 且没有 `subtype` / `bot_id` 的消息；自己发的消息不会再次触发回合。
- 回复走 `chat.postMessage`（`mrkdwn: false`，不让模型输出被 Slack 解析成富文本副作用）。
- 断线后重新 `apps.connections.open`，失败继续退避重连。
- 需要 Slack App 开启 Socket Mode，并给 bot 授予 `chat:write`、`channels:history` / `im:history` 等事件权限。

### Webhook

- 入站：`POST /api/platforms/:id/webhook`，body：
  ```json
  { "externalUserId": "u1", "chatId": "c1", "chatType": "private", "text": "你好", "replyUrl": "可选" }
  ```
  配置了 secret 时必须带 `x-amadeus-secret` 头。
- 出站：POST 到 `outboundUrl`（或在入站里用 `replyUrl` 覆盖），body 带 `platformId/chatId/chatType/text`。
- 入站立即返回 202，回合在后台跑完再回调出站地址。

## 4. 管理界面

设置 → **通讯平台**：

- 新增/编辑/删除、启用开关、真实测试发送（Telegram / OneBot / Discord / Slack 需要配置测试会话 ID，OneBot 支持 `group:123` 或 `123`）
- 卡片显示实时状态（运行中 / 已停止 / 异常 + 错误原因），面板打开时每 5 秒刷新
- 密钥字段只进不出：列表只回传 `tokenSet` / `accessTokenSet` / `botTokenSet` / `appTokenSet` / `secretSet`，编辑时留空表示保持原值
- Webhook 卡片提供「复制入站地址」

## 5. 安全边界

- 平台 Token / Access Token / Webhook secret 存在本机 SQLite，不出现在列表接口、日志、截图中。
- Webhook 入站支持共享密钥；未配置密钥时任何能访问大脑端口的人都能投递消息——生产环境请配置密钥或限制监听地址。
- 适配器只处理文本：图片、语音、文件、表情不会进入模型（避免误把二进制当文本）。
- 同一平台连接只应由一个 brain 进程持有（Telegram 长轮询与 OneBot 连接都会抢占同一账号）。

## 6. 已知限制（与成熟多平台方案的差距）

- 未接微信 / 钉钉 / QQ 官方机器人；框架已抽象，新增适配器只需实现 `PlatformAdapter` 三件事。
- 不做富媒体与表情、引用回复、多账号负载均衡：图片 / 语音 / 文件不会进入模型。
- 飞书仍是 `.env` 配置的内置渠道，尚未迁到平台表（行为不受影响）。
- Discord 需要开启 privileged 的 Message Content Intent，否则正文为空；Slack 需要 app 配置 Socket Mode 与事件订阅。

## 7. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/platform.ts` | 平台类型 / 状态 / 入站消息 |
| `services/brain/src/platforms/types.ts` | 适配器接口、分段发送 |
| `services/brain/src/platforms/telegram.ts` | Telegram 长轮询适配器 |
| `services/brain/src/platforms/onebot.ts` | OneBot v11 WebSocket 适配器 |
| `services/brain/src/platforms/discord.ts` | Discord Gateway + REST 适配器 |
| `services/brain/src/platforms/slack.ts` | Slack Socket Mode 适配器 |
| `services/brain/src/platforms/webhook.ts` | 通用 Webhook 适配器 |
| `services/brain/src/platforms/pipeline.ts` | 绑定、会话、回合、记忆、指标、回复 |
| `services/brain/src/platforms/manager.ts` | 生命周期、状态、启停同步、测试发送 |
| `services/brain/src/routes/platforms.ts` | `/api/platforms*` 与 Webhook 入站 |
| `services/brain/src/db.ts` | `platforms` / `platform_accounts` 表；会话归属转移 |
| `apps/desktop/src/renderer/src/features/settings/PlatformsPanel.tsx` | 管理界面 |

## 8. 验证

```bash
# 终端 1：大脑（读取 services/brain/.env）
npm run dev:brain

# 终端 2：桌面端 dev
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

# 终端 3：平台适配器 E2E（本地 mock Telegram / OneBot / Discord / Slack / Webhook，无需真实账号）
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-platforms.mjs
```

`scripts/e2e-platforms.mjs` 覆盖：Webhook 密钥校验/入站回合/出站回复/渠道标记/测试发送；
Telegram 长轮询、消息→回合→sendMessage、测试会话；OneBot 私聊事件→send_private_msg、
群测试发送；Discord Gateway 握手/心跳/MESSAGE_CREATE→REST 回复/忽略其它 bot/@everyone 不被 ping/
测试发送；Slack Socket Mode 连接/事件 ack/回合/chat.postMessage/忽略 bot 消息/测试发送；
桌面端新增/编辑/启停/删除通讯平台。全部走真实模型回合（LLM 不可用时脚本会明确报错，不伪装通过）。
