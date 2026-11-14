# pi-amadeus
基于Pi Agent二次开发的Amadeus，旨在打造一个综合的个人助手

## Agent 工作台与多端协同

在顶栏「Agent 工作台」管理内置与本机 CLI Agent、派发/停止/继续任务、查看实时输出、依赖与交接画布。在设备页显式开启协同后，手机或另一台电脑可用浏览器配对；默认仅观察，控制权限和 Agent 的远程执行均需在桌面主动开启。

配置、兼容性、安全边界与验证命令见 [Agent 工作台与多端协同](docs/agents-and-collaboration.md)。

自托管 Relay、Docker + Caddy、Cloudflare Workers 和生产部署说明见 [Relay 与部署](docs/relay-and-deployment.md)。

### 隐私与权限

任务和设备记录保存在本机 SQLite；内置任务使用既有模型服务，外部 CLI 使用其自身登录与数据策略。提示词、选定的交接上下文以及工具结果会发送给所选模型/CLI；不会自动收集或上传电脑上其它 Agent 的历史会话。后台任务不召回陪伴记忆，也不把编码结果自动写成长期记忆。

局域网协同默认关闭，设备 token 服务端只存哈希，撤销立即失效。当前 LAN 传输为 **未加密 HTTP**，只用于受信网络；需要跨网请先配置 TLS/SSH/VPN，勿直接映射到公网。CLI 工作目录不是沙箱，允许远程执行相当于授权该 Agent 以本机用户权限处理任务。





🙏 Live2D 资源致谢：[ai-poet/amadeus-system-new](https://github.com/ai-poet/amadeus-system-new)
