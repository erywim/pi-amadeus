# 联网搜索与网页读取

## 1. 设计依据与边界

参考 [OpenClaw 的 Web Search](https://docs.openclaw.ai/tools/web) 与
[DuckDuckGo provider](https://docs.openclaw.ai/tools/duckduckgo-search)：
搜索与读取网页分开、结构化 provider 结果归一化、配置存在不代表健康、诊断必须执行真实查询、
取消不是服务故障，HTML 搜索只能作为尽力可用的入口。这是行为参考，没有复制其实现。

本项目仍走自己的 Brain HTTP 工具，不是模型供应商托管的 native search，也不需要安装一个
「搜索技能」才能使用。当前 **文本 Agent、自动化、通讯平台**可调用工具；**陪伴/语音回合
尚无工具循环**，不能声称它们已经真实搜索。纯 JavaScript 渲染页、登录页、验证码不尝试绕过。

| 工具 | 能力 |
| --- | --- |
| `search` | 搜索并返回标题、原文链接、摘要；模型回答应附来源，不能把失败编成零匹配 |
| `fetch_url` | 打开公网 http(s) 原文，HTML 转文本；有字节/字符上限并明确标注截断 |

## 2. 搜索状态与降级

默认顺序：**Tavily（有密钥时）→ Bing → 360 → 搜狗 → DuckDuckGo HTML**。
DuckDuckGo 使用网页结果，不再把 Instant Answer 的知识摘要当作通用搜索。

- 单引擎最多 8 秒，整条链共用 20 秒预算；用户取消立即终止，不启动后续引擎。
- `success`：拿到可用命中；保留之前失败的引擎及原因。
- `empty`：至少一个引擎明确完成但没有匹配；不是网络故障。
- `failed`：没有引擎完成查询。工具抛真实错误，工具卡不再显示成功。
- HTTP 200 的验证码页是 `blocked`；没有可识别结果且没有零命中提示是 `parse_failed`，
  两者都不能解释成「网上没有」。不做反爬对抗。
- `freshness` 在 Tavily 映射为 `time_range`、Bing 映射为时间 filters、DuckDuckGo 映射为 `df`。
  360/搜狗不支持时效条件时明确跳过，不用不限时间结果冒充最近结果。

网页结果用 DOM 选择器解析，容忍属性顺序、单双引号与额外 class。清洗时先过滤推荐词与
非 HTTP 链接，再去重，最后按条数截断；保留文档 id/签名/跳转 token 等查询参数，只去锚点与
已知追踪参数。Bing 与 DuckDuckGo 的可解码跳转恢复为原文 URL。

## 3. 网络配置

`search`、`fetch_url` 与设置页诊断使用同一份实际出站配置：

1. 显式 `SEARCH_PROXY` 优先，**空字符串表示直连**。
2. 未设置时继承当前用户实际选中的模型服务代理（包括健康/配额路由后的目标）。
3. 没有代理配置时直连。不把宿主 shell 的失效 HTTP_PROXY 当作搜索的隐式配置。

```dotenv
TAVILY_API_KEY=
# SEARCH_PROXY=http://127.0.0.1:7890
# SEARCH_PROXY=
# SEARCH_TAVILY_URL=https://api.tavily.com/search
# SEARCH_BING_URL=https://cn.bing.com/search
# SEARCH_SO_URL=https://www.so.com/s
# SEARCH_SOGOU_URL=https://www.sogou.com/web
# SEARCH_DUCKDUCKGO_URL=https://html.duckduckgo.com/html/
```

端点覆盖是用户的可信配置，允许已有查询参数；关键词通过 URLSearchParams 加入。
Tavily 密钥只由服务端环境读取，不回传。HTML 引擎随站点改版/网络变化可能不可用，
生产使用建议配置结构化 API。**不能保证免密钥引擎在所有网络一直可用。**

## 4. 设置页与诊断

设置 → 联网搜索：并发探测五个引擎，显示首条命中或真实错误、耗时以及直连/代理路径。
试搜结果标明查询词，零匹配与故障分别展示。按钮/Enter 共用同步锁；卸载取消请求，
旧响应不能覆盖新面板。

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| GET | `/api/search/status` | 当前用户实际网络路径下的并发探测，不缓存 |
| POST | `/api/search/test` | `{ query, engine?, maxResults?, freshness? }` → `status/hits/errors` |
| POST | `/api/search/fetch` | `{ url, maxChars? }` → 与工具相同的网页提取结果 |

## 5. 网页读取安全与真实性

公网 URL 校验覆盖 IPv4/IPv6（含映射地址）、DNS 的全部解析结果与每次重定向；连接固定到
已校验 IP，避免校验后重新解析到私网。知识库 URL 导入也复用同一读取器。
二进制/媒体拒绝，支持响应头与 HTML 声明字符集；越界实体不会让解析器抛 RangeError。
达到字节上限后，即便清洗后的正文很短，也必须标记截断，不能假装读完。

**代理限制**：当前公网读取器不能验证 HTTP 代理实际连接到的 IP，所以 `fetch_url` / 知识库
公网抓取在有代理时明确拒绝，而不是静默绕过安全检查或静默改成直连。可显式
`SEARCH_PROXY=` 使用经过 DNS 固定校验的直连，或使用用户自行信任的独立抓取服务。
搜索端点是可信配置，其搜索请求仍支持代理。

## 6. 验证

```bash
# 完全离线：随机环回端口，解析/错误/时效/取消/总预算
node scripts/e2e-search-contract.mjs
# 公网抓取的 DNS/重定向/IPv6/二进制/字符集/截断边界
node scripts/e2e-fetch-contract.mjs
# 自起隔离 brain + mock 引擎，验证 HTTP 与 Agent 接线
node scripts/e2e-search.mjs
```

真实搜索需另外联网验证；本地 mock 的通过不代表真实搜索引擎此刻可达。真实模型是否调用
`search` 必须依据 tool_start/tool_end 与最终回复确认，不能把模型报错或未调用算作通过。
