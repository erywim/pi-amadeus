# Agent 工作台与多端协同

PIAM-6 在现有 Brain 内新增任务控制面，普通聊天、语音与 Live2D 仍走原来的回合路径。参考 Alma 的 Agent 发现、执行血缘、跨端观察与配对撤销行为，业务实现独立编写，不依赖 Alma 服务器、原始二进制或账号。

## 设计决策与边界

选择「单台执行电脑 + 多个受信客户端」，而不是同步 SQLite 文件或新增分布式服务。只做只读列表不能完成派发/接管；直接把原有 API 暴露到局域网会暴露配置、MCP 与文件执行权，因此使用单独的、默认关闭的受限监听器。

```text
Electron 工作台 ── 原生 IPC / loopback HTTP ─┐
                                          ├─ AgentManager ── SQLite
手机/另一台电脑浏览器 ─ 配对 Bearer + SSE ──┘       ├─ 内置 Brain Agent
                   独立 LAN 端口                  └─ 本机 CLI 子进程
```

这是跨 shared、Brain、Electron、React、文档与测试的横切改动，超过八个文件，但不新增服务、运行时或依赖。

- **构建的能力**：Agent 配置、已安装命令发现、任务派发/排队/停止/继续/交接、输出与事件持久化、依赖关系、带版本冲突检测的画布坐标、桌面看板与手机控制页、配对角色与撤销。
- **不包含**：Alma 原生终端窗格接管、读取其它软件现存私密会话、交互式 PTY、多台执行主机自动发现、SSH 远端文件管理、团队成员聊天、自动 Sprint 评估。这些需要独立的身份/传输/协议实现，不能由一个通用 CLI 启动器冒充。自托管 Relay、E2E 隧道、APNs/FCM/TURN 的部署与协议实现见 [Relay 与部署](relay-and-deployment.md)；它们与本地 HTTP LAN 网关是两条独立路径。
- 当前基线没有名为 Lancer 的画板代码。本次提供任务节点与依赖/交接投影的工作台画布；它不导入其它分支的未合并界面。

## 用户入口

顶栏 **Agent 工作台**：左侧 Agent 工位，中间任务看板/画布，选择任务后查看输出与操作。Agent 角色说明与模型只作用于工作台任务，不覆盖用户原有模型设置。内置 Amadeus 复用已配置的模型服务与工具；任务有独立会话，不召回陪伴人格、记忆或好感度，也不将编码结果自动提取为长期记忆。

外部 CLI 必须在运行 Brain 的电脑上已安装并完成其自身登录。子进程只继承 PATH、HOME、XDG、locale、临时目录等基础环境，不继承 Brain 的 API key/token；只靠环境变量认证的 CLI 需自行配置其本机认证文件。发现只是 PATH 与版本探测，不会安装软件或开始收费执行。适配器兼容不同 CLI 的非交互模式，不承诺每个版本均通过真实供应商测试；界面显示缺失命令与真实错误。自定义适配器使用绝对可执行路径、参数数组和 stdin/独立参数形式的提示词，不把提示词拼入 shell。

「继续」创建独立尝试并保留来源任务与原始输出；不是伪造原 CLI 的原生会话恢复。「交接」给另一个 Agent 新建带前序结果的任务，保留父任务/mission 链路。

## 执行状态与持久化

共享契约在 [agents.ts](../packages/shared/src/agents.ts)，运行在 [AgentManager](../services/brain/src/agents/manager.ts)，持久化在 [AgentStore](../services/brain/src/agents/store.ts)。表是原有 SQLite 的增量扩展，不删除或重写旧会话/密钥。

```text
queued ── 有并发配额且依赖完成 ──> running ──> completed / failed
  │                                  │
  └─ 停止/依赖失败 ──> cancelled       ├─ bash 待审批 ──> waiting_approval ──> running
                                     ├─ 停止 ──> cancelled
                                     └─ 重启/服务退出 ──> interrupted
```

- Brain 拥有执行生命周期；关闭页面、SSE 断开或切换设备只取消订阅，不停止任务。
- 同一 `userId + requestId` 幂等，避免网络重试重复启动任务。
- 全局并发上限 3；同一规范工作目录的任务串行，避免两个编码 Agent 同时改同一目录。独立 worktree 可并行。
- 任务依赖必须属于同一个用户，依赖成功后才能执行，失败/取消时不会无限等待。
- 任务输出保留 UTF-8 尾部 256 KiB，每用户事件保留最近 2000 条；任务超时为 30 分钟。事件有序列号，前端重连后先同步真实快照再订阅。坐标写入携带 `revision`，旧版本返回 409，不静默覆盖另一端编辑。
- 进程中断保留历史与输出，明确标记 `interrupted`。继续必须显式触发，不盲目重放可能有副作用的命令。
- 只停止本管理器创建的子进程/进程组，不用进程名杀死电脑上其它 Agent。
- bash 审批请求绑定 `turnId + toolCallId`，延迟或重复的旧确认不能放行下一条命令；超过 16 KiB（UTF-8 字节）的命令在创建审批前拒绝，预览绝不截断隐藏可执行内容。

## 设备配对和安全

设备管理代码在 [CollaborationManager](../services/brain/src/collaboration/manager.ts)，手机网页是 [client.html](../services/brain/src/collaboration/client.html)。

1. 桌面登录后，在工作台设备页显式开启局域网协同。
2. 创建一次性、短时有效的配对码，选择观察者或控制者（默认观察者）。
3. 在另一设备打开显示的局域网 URL，输入配对码和设备名。
4. 观察者只能看任务；控制者只能管理绑定用户的任务。新建/继续仅限桌面明确开启「允许远程」的 Agent。
5. 桌面撤销设备会立即关闭其事件流并拒绝原 token；关闭协同则停止 LAN 监听。

旧 API 显式绑定 `127.0.0.1`；受限网关不代理 `/api/config`、`/api/plugins`、`/api/users`、任意文件或通用 shell 接口。设备身份由 token 对应记录决定，不信任请求体里的用户 id。token 只在配对响应中发一次，数据库只保存哈希，不放进 URL。网页凭据默认只留在当前页面内存；刷新后重新配对。可显式选择当前标签页的 sessionStorage 暂存（界面提示共享设备风险），不会写入 localStorage。

**HTTP LAN 不是加密传输**：只在受信局域网使用；同网段监听者可能看到 token、提示词与输出。需要跨网时请使用 [Relay 与部署](relay-and-deployment.md) 中的 E2E Relay，或配置受信 TLS/SSH/VPN；不能直接把此端口映射到公网。程序不自动开防火墙、建隧道或上传数据。

外部 CLI 继承其自身用户权限，工作目录不是 OS 沙箱。允许远程 Agent 代表授予该适配器在此电脑上执行任务的能力；只启用自己信任的命令与设备。内置工具仍执行既有安全检查和 bash 审批，不加入绕过权限参数。受信桌面通过限制路径与发送者的原生桥访问管理 API，不把任意 `Origin:null` 当作本机授权。

## API 与真实源头

- [本机 Agent 路由](../services/brain/src/routes/agents.ts)：发现/配置、任务、停止/继续、审批、坐标、事件。
- [本机设备路由](../services/brain/src/routes/collaboration.ts)：状态、显式开关、配对码、撤销。
- [Relay 控制路由](../services/brain/src/routes/relay.ts)：本机 Relay 状态、显式启停、重连；连接码和注册密钥只来自内存/环境变量。
- [Electron 管理桥](../apps/desktop/src/main/agent-ipc.ts)：只代理本机 `/api/agents`、`/api/collaboration` 与受限 `/api/relay`，只接收受信主 frame。
- [管理界面](../apps/desktop/src/renderer/src/features/agents/AgentsPage.tsx)、[HTTP 客户端](../apps/desktop/src/renderer/src/lib/agentApi.ts)、[独立任务 store](../apps/desktop/src/renderer/src/stores/agentStore.ts)：不复用普通聊天唯一的流状态。

## 回退与验证

可关闭 LAN 协同并移除工作台入口回退；不需要删除任务表或改动用户数据。无需新增第三方账号/密钥：内置任务使用现有模型，CLI 使用其自身已登录状态。本地回归用隔离 SQLite、本地模拟模型和确定性测试命令，不读取真实 Agent 记录或真实用户目录。

可复制的验证命令：

```sh
npm ci
npm run verify
node scripts/e2e-tool-approval-abort.mjs
node scripts/e2e-agent-process-stop.mjs
node scripts/e2e-agents.mjs
node scripts/e2e-collaboration.mjs
# 完整桌面回归另需 dev/brain 与隔离数据已启动；CDP 端口可按 AGENTS.md 另选：
npm run e2e
```

覆盖：成功/失败、输入校验、独立输出、请求幂等、并发与依赖、取消、重启中断、继续/交接、坐标冲突、事件重连、未配对/观察者/已撤销设备拒绝、旧 API 不可从网关访问。真实供应商、所有 CLI 版本、物理手机和公网网络路径需要单独实测，不能由模拟执行器测试替代。
