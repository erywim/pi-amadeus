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
- **串行**：同一会话的回合排队执行，平台连发多条不会让上下文交错。最后一条任务成功或失败后释放队列条目，
  避免长时间运行时积累已结束会话；前一条结束不会删除仍在等待的后继，`/bind` 与普通消息共用此规则。
- **记忆/好感度**：和桌面完全共享；绑定后写到同一个 Amadeus 用户身上。
- **指标**：`turn_metrics.channel = 平台类型`，看板渠道分布里能直接看到 Telegram / QQ / Discord / Slack / 微信 / QQ 机器人 / Webhook / 自动化。
- **桌面可见**：会话列表带渠道徽标，点开可以继续聊（平台只是入口之一）。

## 2. 身份绑定

- 未绑定：按 `<kind>-<externalUserId>` 自动建档（每个外部账号一个用户）。
- 已绑定：在平台里发 `/bind <绑定码>`（绑定码在「设置 → 飞书」生成），外部账号之后使用该桌面身份。
  在私聊内绑定会立即迁移这段私聊；在群里绑定不会迁移群，绑定者下次进入自己的私聊时才迁移该私聊。
  不按用户名批量搬迁，也不迁移其它人的私聊。
- 群聊与私聊使用各自的会话；同一用户在不同群里的上下文互不串。
- **群 owner 策略**：已有群会话保持现有 owner；新群由首个创建会话的回合确定 owner。
  后续换说话人、成员 `/bind`，甚至 owner 自己绑定新身份，都不会转走整群历史。
  群回合的配置、记忆/好感度与指标继续归同一 owner；不新增群权限或跨成员记忆合并。
  owner 在会话串行队列内读取，避免并发首轮先按各自身份准备上下文。

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
- 附件 URL 会下载为图片 / 音频 / 文件；正文为空但有附件的 `MESSAGE_CREATE` 同样进入管线。
  `referenced_message` 作为引用上下文；回复带 `message_reference`。
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
- 处理 `event.type = message`、无 subtype 或 `subtype = file_share` 的文本/纯文件消息；忽略其它 subtype、`bot_id` 与自己发的消息，编辑/删除事件不会再次触发回合。
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
- 微信公众号回调必须通过签名校验；Webhook 入站支持共享密钥；未配置密钥时任何能访问大脑端口的人都能投递消息——公网暴露前请配置密钥或用防火墙/代理限制来源；本次边界收紧不自动创建、替换或修改已有密钥。
- 附件落盘在 `data/media`，媒体接口用随机 UUID 访问；原始文件名只作展示，不参与路径。
- 同一平台连接只应由一个 brain 进程持有（Telegram 长轮询、OneBot、QQ 网关都会抢占同一账号）。

### brain HTTP 管理面

真实入口在 `services/brain/src/index.ts`；`services/brain/src/http/access.ts` 的 `createHttpApp` 在任何 `/api/*` 处理器之前校验请求，避免只删 CORS 响应头但简单 POST 仍执行命令。配置由 `services/brain/src/config.ts` 的 `loadConfig` 只读环境变量，不落入用户设置、不回传密钥、不添加登录弹窗。

| 环境变量 | 默认与边界 |
| --- | --- |
| `BRAIN_HOST` | `127.0.0.1`，仅本机 IPv4 loopback；公网/LAN 回调必须显式设为 `0.0.0.0` 或所需接口地址，IPv6 本机可设 `::1`。不设置时不再监听全部接口。 |
| `BRAIN_ALLOWED_HOSTS` | 逗号分隔的额外精确 HTTP Host（非 URL，含非默认端口，例如 `brain.example:3002`）。本机 `localhost` / `127.0.0.1` / `[::1]` 加 `PORT` 始终允许；无通配符，不做 DNS 解析，不信任相似后缀或 `X-Forwarded-Host`。 |
| `BRAIN_ALLOWED_ORIGINS` | 默认精确允许 `http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173`。配置时替换此列表；Vite 换端口时显式列入真实 Origin，不可用 `*`、路径或 `null`。 |
| `BRAIN_ALLOW_FILE_ORIGIN` | 默认 `true`。仅真实 loopback 对端且 UA 带 `Electron/` 时兼容打包 `file://` 的 `Origin: null` 或无 Origin 资源；可设 `false` 禁用。普通浏览器 sandbox/data 的 `null` Origin 拒绝。 |
| `BRAIN_ADMIN_TOKEN` | 默认为空，非 loopback 管理请求一律 403。配置后，远端客户端须逐次带 `Authorization: Bearer <token>`，仍不能绕过 Host / Origin 校验；本机前端不需要 token。 |

- 对端身份只取 Node socket 的实际 `remoteAddress`（含 IPv4-mapped IPv6），忽略 `Forwarded` / `X-Forwarded-For`。没有连接元数据时按远端处理，不回落成「本机」。
- 浏览器明确带 Origin 时必须在精确列表中；不因持有 Bearer 就允许任意网站。不带 Origin 的 cross-site / 非可信 same-site 请求也拒绝。Vite 媒体标签的无 Origin 只读 GET/HEAD 需 Referer 的 Origin 在列表中；本机无浏览器来源的 CLI 正常可用。可信配置 Origin 的跨端口/跨 loopback 地址调用仍兼容。
- 预检仅为允许的 Origin 返回精确 CORS，不返回 `*`；远端 Bearer 预检可不携带 token，但随后的实际请求仍必须验证。公开回调不授予浏览器管理面 CORS。
- **仅以下精确方法与路径不走管理面 Host / Origin / 本机限制**：`GET/POST /api/platforms/:id/wechat`、`POST /api/platforms/:id/webhook`、`POST /api/automations/:id/trigger`。它们继续使用各自既有签名 / `x-amadeus-secret`，不把平台列表、编辑、测试发送等管理接口一起公开。通用 Webhook 的 secret 可选，旧自动化的空 secret 也不会在本次修复中被更改；这类配置没有匿名公网安全保证。
- **legacy 飞书** `POST /api/feishu/webhook` 当前没有既有签名校验，因此保留本机原入口，但不豁免匿名公网。若原来公网直连飞书，收紧后会返回 403，需要迁移到带验签的入口/受控认证代理，或由受控客户端显式使用管理 Bearer；不能直接把整个 API 反向代理成「本机」。本次未新增飞书验签或修改用户凭据。
- **代理部署约束**：从 loopback 连接的反向代理/隧道与本机程序不可区分。代理必须只转发上述公开回调，并保留外部 Host；禁止把整个 `/api` 改写为 `Host: localhost:<PORT>` 后无鉴权公开，否则会重新打开本机信任边界。远端管理应使用 HTTPS、显式 Host/Origin 与 Bearer，并在代理层限制来源。
- **保护范围**：loopback + Host / Origin 主要拦远程直连、普通恶意网页和 DNS rebinding，不是本机恶意程序防护，也不是多用户隔离。原生程序可伪造 UA/请求头；Electron 内任意不可信页面同样不是受隔离的身份。不要在受信 Electron renderer 或允许的开发 Origin 下加载不可信内容。

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
# HTTP 边界独立回归（无已运行服务/CDP前置；不打开真实 DB，不启动 MCP）
node scripts/e2e-http-boundary.mjs

# 独立业务回归（临时 SQLite + 本地 HTTP/WS mock，无真实账号/桌面/模型依赖）
node scripts/e2e-regression-contracts.mjs

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
