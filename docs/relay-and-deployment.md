# Relay 与部署

本项目现在提供一个独立的自托管 Relay 服务，兼容 Alma Relay 的路由和传输协议，并提供可选的 Cloudflare Workers、Docker + Caddy 和反向代理部署方式。

## 拓扑

```text
手机 / 浏览器 ── HTTPS/WSS /c/<routing-token>/... ──┐
                                                      │
桌面 Relay Client ── WSS /agent?th=<token-hash> ── Relay
      │
      └── E2E tunnel（P-256 ECDH + HKDF-SHA256 + AES-256-GCM）── Brain loopback API
```

Relay 只保存内存中的路由 hash，不持久化连接码和业务 payload。启用 E2E 时，Relay 只能转发加密 tunnel，不能读取 Brain API、SSE 或 WebSocket 内容。

## Node / Docker + Caddy

```sh
cd services/relay
cp .env.example .env
# 修改 RELAY_DOMAIN，并按需设置 RELAY_REGISTRATION_KEY 或 RELAY_TOKEN_SECRET
docker compose config   # 先确认变量解析和构建上下文
docker compose up -d
curl -fsS https://relay.example.com/healthz
```

Compose 直接用 `services/relay` 作为构建上下文，把当前代码构建成 `pi-amadeus-relay:latest`；
`services/relay/package-lock.json` 是 Docker 构建所需的独立 lockfile，不要删除。

`docker-compose.yml` 包含 Relay、Caddy 自动 HTTPS，以及可选的 coturn profile：

```sh
# .env 中还必须设置 TURN_SECRET（以及按需设置 TURN_URLS）
docker compose --profile turn up -d
```

未启用 `turn` profile 时不需要 `TURN_SECRET`；若启用了 profile 却没设置，
coturn 容器会直接报错退出，而不是以空密钥启动。

只使用已有反向代理时：

```sh
docker build -t pi-amadeus-relay services/relay
docker run -d --restart unless-stopped --name pi-amadeus-relay \
  --env-file services/relay/.env -p 127.0.0.1:8787:8787 pi-amadeus-relay
```

反向代理必须支持 WebSocket 升级，并关闭 SSE 响应缓冲；参考 `services/relay/deploy/Caddyfile`。生产环境必须使用 HTTPS/WSS，不要把明文 Relay 暴露到公网。

## Cloudflare Workers

`services/relay/cloudflare/worker.mjs` 使用 SQLite-backed Durable Objects 保存活动连接状态（不保存业务数据）。部署前在 `services/relay/wrangler.jsonc` 中设置 Worker 名称、域名和非敏感变量；密钥通过 Wrangler secret 注入：

```sh
cd services/relay
npx wrangler secret put RELAY_REGISTRATION_KEY
npx wrangler deploy
```

Cloudflare Worker 无法直接访问本机 `127.0.0.1:3002`；桌面端必须通过 WSS 主动拨号 Relay。不要把 Brain 的 `BRAIN_HOST` 改成公网来“替代” Relay。

## 访问控制

- `RELAY_REGISTRATION_KEY`：所有桌面注册共享密钥。
- `RELAY_TOKEN_SECRET`：签发带 `aud=alma-relay`、`sub`、`exp` 的 HS256 注册令牌。
- 个人令牌：

```sh
cd services/relay
RELAY_TOKEN_SECRET='replace-me' node scripts/mint-token.mjs desktop-owner 365
```

连接码是桌面设备的 256-bit bearer secret。重新生成后，旧配对必须进入 replaced/失效流程；不要记录连接码、routing token、注册密钥或完整 Bearer token。

## 协议

协议细节见 `services/relay/PROTOCOL.md`，包含：

- `/agent?th=<token-hash>` 桌面注册
- `/c/<token>/...` 手机 HTTP/WebSocket 隧道
- 协议 1 JSON、协议 2 二进制/流式请求体、协议 3 每流响应窗口
- HTTP/SSE/WebSocket relay semantics
- E2E tunnel 的内层路径 `/__alma_e2e__`

本仓库的 Brain-side Relay client 与 E2E responder 代码位于 `services/brain/src/relay/`；它只允许访问 loopback Brain，不把手机传入的 Host/Connection/Content-Length 等敏感 hop-by-hop headers 透传。

## 本地验证

```sh
# Relay 语法和独立 health smoke
node --check services/relay/index.mjs
node --check services/relay/shared.mjs
PORT=18787 HOST=127.0.0.1 node services/relay/index.mjs &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
curl -fsS http://127.0.0.1:18787/healthz
```

部署文件静态检查（`docker compose config` 需要先在 `services/relay` 下准备好带
`RELAY_DOMAIN` 的 `.env`）：

```sh
cd services/relay
cp -n .env.example .env
docker compose config
docker compose --profile turn config   # 未设置 TURN_SECRET 也应能解析
cd ../..
docker build -t pi-amadeus-relay services/relay

# Cloudflare Worker 打包、Durable Object 绑定与兼容性配置校验
cd services/relay
npx wrangler deploy --dry-run
```

桌面端与手机端的真实互操作需要隔离 Brain、隔离端口和测试连接码；不得使用用户真实 SQLite、Electron userData、模型凭证或现有 Relay。

## 当前边界

- Relay 服务、Docker/Caddy 和 Cloudflare Workers 已提供协议/部署实现。
- Brain-side Relay client/E2E responder、Electron Relay 设置面板和本地 fake-relay E2E 验证已接入；当前仍未提供设备二维码/手机原生 App 或推送设备注册，LAN 浏览器协同仍保留为独立的 HTTP 配对网关。
- Electron 面板输入的 Relay 地址、连接码、注册密钥和用户绑定只提交给本次 Brain 进程内存；状态接口不会返回连接码、注册密钥或 token hash。Relay 远程只开放健康检查和绑定用户的 Agent 工作台路径，拒绝 Relay/LAN 管理面、聊天、配置、插件和文件路径。
- APNs/FCM/TURN 依赖各自平台凭证，未在本地默认启用。
