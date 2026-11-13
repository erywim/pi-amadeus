# 通讯平台接入（Platforms）

参考常见的多平台接入思路：把「外部聊天平台」抽象成适配器，
所有平台共用同一套身份、会话、记忆、好感度与指标，桌面端能看到并继续这些对话。

当前支持七类适配器（飞书仍由 `.env` 配置，是内置渠道）：

| 类型 | 传输 | 典型用途 |
| --- | --- | --- |
| `telegram` | Bot API 长轮询（getUpdates / sendMessage） | 不需要公网地址，填 Bot Token 即用 |
| `onebot` | OneBot v11 正向 WebSocket | 接 NapCat / Lagrange 等 QQ 协议端 |
| `discord` | Gateway WebSocket（v10）+ REST | 填 Bot Token；需在 Developer Portal 开启 Message Content Intent |
| `slack` | Socket Mode WebSocket + Web API | 填 bot token（xoxb）与 app token（xapp），不需要公网回调地址 |
| `wechat` | 公众号回调 HTTP + 客服消息 API | 填签名 Token / AppID / AppSecret；需要公网回调地址 |
| `qqbot` | QQ 官方机器人 WebSocket 网关 + REST | 填 AppID / AppSecret；监听 C2C 与群 @ 消息 |
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
- **指标**：`turn_metrics.channel = 平台类型`，看板渠道分布里能直接看到 Telegram / QQ / Discord / Slack / 微信 / QQ 机器人 / Webhook / 自动化。
- **桌面可见**：会话列表带渠道徽标，点开可以继续聊（平台只是入口之一）。

## 2. 身份绑定

- 未绑定：按 `<kind>-<externalUserId>` 自动建档（每个外部账号一个用户）。
- 已绑定：在平台里发 `/bind <绑定码>`（绑定码在「设置 → 飞书」生成），之后消息都记在该桌面用户名下。
  绑定后该会话的归属会转移到绑定用户，桌面端立刻能在列表里看到并继续。
- 群聊与私聊使用各自的会话；同一用户在不同群里的上下文互不串。

## 3. 适配器细节

### Telegram

- 启动时 `getMe` 校验 Token，状态里显示 `@botname`。
- `getUpdates` 长轮询（timeout 25s）；忽略 bot 自己与其他 bot。
- 文本 / 图片（最大一张）/ 语音 / 音频 / 文件：媒体先用 `getFile` 拿 `file_path` 再下载为 base64；
  `reply_to_message` 的正文作为引用上下文。
- 回复按 4000 字分段；有 `message_id` 时带 `reply_parameters` 引用原消息。
- 长轮询超时不算错误，网络失败进入 error 状态并 5s 后重试。
- 可配置 `baseUrl` 指向自建/测试端点（E2E 用它接本地 mock）。

### OneBot v11

- 正向 WebSocket 连接（`ws://host:port`），`access_token` 走查询参数。
- 处理 `post_type=message` 的私聊/群聊事件；文本取 message 段里的 text，兜底 `raw_message`。
- message 段里的 `image` / `record` / `file` / `video` 会下载为附件；`reply` 段通过 `get_msg` 反查原消息正文作为引用。
- 回复发 `send_private_msg` / `send_group_msg`；有 `message_id` 时用 `[reply, text]` 数组被动回复。
- 断线 3s 自动重连；状态在 running/error 之间切换。

### Discord

- 启动时先 `GET /users/@me` 校验 Bot Token，再连 Gateway（默认 `wss://gateway.discord.gg/?v=10&encoding=json`）。
- 协议：HELLO(op 10) → IDENTIFY(op 2，intents = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT)
  → 心跳(op 1) / ACK(op 11)；`MESSAGE_CREATE` 事件进入管线。
- 回复走 REST `POST /channels/:id/messages`，按 1900 字分段，并带
  `allowed_mentions: { parse: [] }`——模型输出里的 `@everyone` 不会真的 ping 全群。
- 忽略所有 `author.bot`（含自己）的消息，避免回声；op 7 / op 9 与连接关闭都走同一套 3s 重连。
- 附件 URL 会下载为图片 / 音频 / 文件；`referenced_message` 作为引用上下文；回复带 `message_reference`。
- 可配置 `gatewayUrl` / `apiBaseUrl` 指向本地 mock（E2E 用它验证完整协议链路）。

### 微信公众号

- 回调用 `GET /api/platforms/:id/wechat` 做服务器地址校验（`sha1(sort(token,timestamp,nonce))` + `echostr`），
  `POST` 收 XML 消息/事件。签名、Token、AppSecret 都只存服务端。
- 回合耗时超过被动回复窗口，所以入站立即回 `success`，再用客服消息 API 异步回复（文本按 1800 字分段）。
- 图片优先用 `PicUrl` 下载，语音用 `MediaId` 走媒体接口；微信自带 `Recognition` 文本优先于本地 STT。
- 需要公众号后台把服务器地址指向该回调，并配置同样的 Token。

### QQ 官方机器人

- AppID + AppSecret 换 `access_token`，`GET /gateway` 拿 WebSocket 地址；心跳 / IDENTIFY / 断线重连与 Discord 类似。
- 监听 `C2C_MESSAGE_CREATE` 与 `GROUP_AT_MESSAGE_CREATE`；去掉 `<@!botid>` 后进入管线。
- 回复走 `/v2/users/:openid/messages` 或 `/v2/groups/:group_openid/messages`，带 `msg_id` 做被动回复；
  `attachments` 会下载为附件。
- 需要 QQ 开放平台创建机器人并配置 IP 白名单 / 权限。

### Slack（Socket Mode）

- 启动时 `auth.test` 校验 bot token 并拿到 bot user id；`apps.connections.open`（app token）换取 WebSocket 地址。
- 收到 `events_api` 信封时**先回 `{ envelope_id }` ack** 再处理（Slack 3 秒内收不到 ack 会重投同一条事件）。
- 只处理 `event.type = message` 且没有 `subtype` / `bot_id` 的消息；自己发的消息不会再次触发回合。
- 回复走 `chat.postMessage`（`mrkdwn: false`，不让模型输出被 Slack 解析成富文本副作用）。
- 断线后重新 `apps.connections.open`，失败继续退避重连。
- 文件（`files[].url_private`）用 bot token 下载为附件；线程消息的回复写回同一 `thread_ts`。
- 需要 Slack App 开启 Socket Mode，并给 bot 授予 `chat:write`、`channels:history` / `im:history` 等事件权限。

### Webhook

- 入站：`POST /api/platforms/:id/webhook`，body：
  ```json
  { "externalUserId": "u1", "chatId": "c1", "chatType": "private", "text": "你好", "replyUrl": "可选" }
  ```
  配置了 secret 时必须带 `x-amadeus-secret` 头。
- 出站：POST 到 `outboundUrl`（或在入站里用 `replyUrl` 覆盖），body 带 `platformId/chatId/chatType/text`。
- 入站立即返回 202，回合在后台跑完再回调出站地址。

## 4. 媒体与引用

- 入站附件统一为 `PlatformMedia { kind, name, mimeType, data(base64), size }`，交给共用管线落盘
  （`data/media`），消息列表返回 `/api/media/<id>`；文本文件正文与语音转写会进入本轮与后续回合的上下文。
- 图片只有在模型支持视觉输入时才会作为 image content 发送；纯文本模型会看到「收到 N 张图片但模型不支持图像输入」的说明，不会静默丢弃。
- 引用：Telegram / Discord / OneBot / QQ 机器人会带被引用消息正文并在回复里引用原消息；
  Slack 用线程回复；微信客服消息不支持引用。
- 平台侧上限：单附件 20MB（语音 25MB），超出会跳过并记录日志；图片附件入模型前按模型能力门控。

## 5. 管理界面

设置 → **通讯平台**：

- 新增/编辑/删除、启用开关、真实测试发送（Telegram / OneBot / Discord / Slack / 微信公众号 / QQ 机器人需要配置测试会话 ID 或 OpenID，OneBot 支持 `group:123` 或 `123`）
- 卡片显示实时状态（运行中 / 已停止 / 异常 + 错误原因），面板打开时每 5 秒刷新
- 密钥字段只进不出：列表只回传 `tokenSet` / `accessTokenSet` / `botTokenSet` / `appTokenSet` / `appSecretSet` / `clientSecretSet` / `secretSet`，编辑时留空表示保持原值
- Webhook 与微信公众号卡片提供「复制入站地址」

## 6. 安全边界

- 平台 Token / Access Token / AppSecret / Webhook secret 存在本机 SQLite，不出现在列表接口、日志、截图中。
- 微信公众号回调必须通过签名校验；Webhook 入站支持共享密钥；未配置密钥时任何能访问大脑端口的人都能投递消息——生产环境请配置密钥或限制监听地址。
- 附件落盘在 `data/media`，媒体接口用随机 UUID 访问；原始文件名只作展示，不参与路径。
- 同一平台连接只应由一个 brain 进程持有（Telegram 长轮询、OneBot、QQ 网关都会抢占同一账号）。

## 7. 已知限制（与成熟多平台方案的差距）

- 未接钉钉 / 企业微信应用 / 微信个人号；框架已抽象，新增适配器只需实现 `PlatformAdapter` 三件事。
- 不做表情、视频理解、多账号负载均衡；引用只支持平台原生能力（微信客服消息不支持）。
- 飞书仍是 `.env` 配置的内置渠道，尚未迁到平台表（行为不受影响）。
- Discord 需要开启 privileged 的 Message Content Intent；Slack 需要 Socket Mode 与事件订阅；微信公众号需要公网回调。

## 7. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/platform.ts` | 平台类型 / 状态 / 入站消息 |
| `services/brain/src/platforms/types.ts` | 适配器接口、分段发送 |
| `services/brain/src/platforms/telegram.ts` | Telegram 长轮询适配器 |
| `services/brain/src/platforms/onebot.ts` | OneBot v11 WebSocket 适配器 |
| `services/brain/src/platforms/discord.ts` | Discord Gateway + REST 适配器 |
| `services/brain/src/platforms/slack.ts` | Slack Socket Mode 适配器 |
| `services/brain/src/platforms/wechat.ts` | 微信公众号回调 + 客服消息适配器 |
| `services/brain/src/platforms/qqbot.ts` | QQ 官方机器人网关 + REST 适配器 |
| `services/brain/src/media.ts` | 附件落盘 / 文本抽取 / 语音转写 / 对外 URL |
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

# 终端 3：平台适配器 E2E（本地 mock Telegram / OneBot / Discord / Slack / 微信公众号 / QQ 机器人 / Webhook）
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-platforms.mjs
```

`scripts/e2e-platforms.mjs` 覆盖：Webhook 密钥校验/入站回合/出站回复/渠道标记/测试发送；
Telegram 长轮询、文本与图片回合、引用回复、测试会话；OneBot 私聊事件、图片+reply 段、reply 数组回复、
群测试发送；Discord Gateway 握手/心跳/MESSAGE_CREATE、图片附件 + message_reference、忽略其它 bot、
@everyone 不被 ping、测试发送；Slack Socket Mode 连接/事件 ack/回合/chat.postMessage/忽略 bot 消息/测试发送；
微信公众号签名校验/文本/图片/客服消息/测试发送；QQ 机器人网关/私聊消息/被动回复/测试发送；
桌面端新增/编辑/启停/删除通讯平台。全部走真实模型回合（LLM 不可用时脚本会明确报错，不伪装通过）。
