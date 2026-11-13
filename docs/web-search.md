# 联网搜索与网页读取

参考常见 agent 的做法：搜索不是「一个有就用、没有就废」的单点，而是**多引擎降级链 +
网页读取**的组合。搜索只给标题、链接与摘要；要读原文时用 `fetch_url` 打开具体页面。

## 1. 两个工具

| 工具 | 能力 | 边界 |
| --- | --- | --- |
| `search` | 关键词搜索，返回标题 / 链接 / 摘要；可指定条数与时效 | 只读摘要，不抓正文 |
| `fetch_url` | 打开一个网页，HTML 转纯文本返回 | 仅公网 http(s)；本机与内网地址拒绝；正文有字符上限并标注截断 |

助手在需要实时信息（新闻、版本发布、价格、天气以外的时效内容）时会自己调用它们，
不需要用户手动触发。

## 2. 多引擎降级

顺序固定，前一个不可达或没有结果时自动换下一个：

```
Tavily（配了 TAVILY_API_KEY 才有）
  → 必应（cn.bing.com）
  → 360 搜索（so.com）
  → 搜狗（sogou.com）
  → DuckDuckGo 即时答案
```

- **单引擎超时 12 秒**：搜索在交互路径上，慢引擎不拖住整回合。
- **空结果继续降级**：不同引擎索引覆盖差异大，「这个引擎没有」不等于「网上没有」。
- **全部失败时把每个引擎的真实原因回给模型**（例如 `bing: 请求失败: HTTP 500`、
  `duckduckgo: 连接超时`），模型据此如实告知用户，而不是编造答案。
- **结果清洗**：过滤「其他人还搜了」「大家还在搜」这类推荐词块、搜索引擎自己的站内链接，
  按 URL 去重（锚点/查询串不同视为同一条）。
- **解析顺序**：先收全部候选 → 过滤杂质 → 去重 → 最后按 `maxResults` 截断。
  反过来做（先截断再过滤）会在杂质排在前面时返回空结果，这是本模块的已知回归点，
  `scripts/e2e-search.mjs` 有专门用例守着。

为什么不用单一引擎：不同网络环境下各站点可达性差异极大。本机实测 DuckDuckGo 完全
连不上（连接超时），而必应 / 360 / 搜狗可以直连——单一引擎实现等于「能不能搜全看运气」。

## 3. 端点可覆盖

镜像站、自建代理或企业内网关可以覆盖引擎地址（留空 = 官方地址）：

```bash
SEARCH_TAVILY_URL=
SEARCH_BING_URL=https://cn.bing.com/search
SEARCH_SO_URL=https://www.so.com/s
SEARCH_SOGOU_URL=https://www.sogou.com/web
SEARCH_DUCKDUCKGO_URL=https://api.duckduckgo.com/
```

E2E 用同一机制把五个引擎指向本地 mock，因此解析与降级链的验证不依赖外网。

## 4. 设置页：联网搜索

设置 → **联网搜索**：

- **引擎状态**：打开面板时逐个真实探测（并发，总耗时约等于最慢的那个）。
  显示每个引擎此刻是否可用、耗时、成功时首条结果标题或失败原因。
  这是运行时事实，不写死「可用」。
- **试搜**：输入关键词真的搜一次，展示命中条数、来源引擎、每条结果，以及前面失败引擎的原因。
- **助手怎么用**：说明 search 与 fetch_url 的分工和边界。

## 5. 诊断接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/search/status` | 五个引擎的真实可达性（并发探测，不缓存） |
| POST | `/api/search/test` | `{ query, engine?, maxResults?, freshness? }` → 命中与逐引擎错误 |
| POST | `/api/search/fetch` | `{ url, maxChars? }` → 网页标题 / 正文 / 截断标记 |

这三个接口不做缓存：用户点「检查」时要看到此刻的真实结果。

## 6. 安全边界

- **只读**：两个工具都不写文件、不改状态。
- **抓取只允许公网 http(s)**：`localhost`、`127.x`、`10.x`、`192.168.x`、`172.16-31.x`、
  `169.254.x` 全部拒绝。模型可以用 bash 访问本机（有确认卡），但网页抓取不该成为
  绕过确认的内网探测通道。
- **二进制不解析**：PDF / 图片 / 音视频 / 压缩包明确告知类型，不把二进制当文本塞进上下文。
- **正文上限**：默认 12000 字符（工具）/ 4000 字符（诊断接口），超出在结果里写明「已截断」。
- **取消**：用户点停止时，搜索与抓取请求随回合 signal 一起结束。

## 7. 代码地图

| 位置 | 职责 |
| --- | --- |
| `services/brain/src/tools/search.ts` | 降级链、四个免密钥引擎的解析、结果清洗 |
| `services/brain/src/tools/fetchUrl.ts` | 网页读取工具、公网地址校验 |
| `services/brain/src/tools/net.ts` | HTTP 客户端、UA、超时、中文错误、HTML→文本 |
| `services/brain/src/routes/search.ts` | `/api/search/*` 诊断接口 |
| `services/brain/src/config.ts` | `TAVILY_API_KEY` 与端点覆盖环境变量 |
| `packages/shared/src/search.ts` | 诊断接口的跨端类型 |
| `apps/desktop/src/renderer/src/features/settings/SearchPanel.tsx` | 设置页面板 |

## 8. 验证

```bash
# 自起一个 brain（端口 3012），五个引擎指向本地 mock，不依赖外网
node scripts/e2e-search.mjs

# 有桌面端 dev（CDP 9333）时一并验证设置页
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-search.mjs
```

`scripts/e2e-search.mjs` 覆盖：必应 / 360 / 搜狗三种 HTML 解析；实体解码；
「杂质在前 + 小 maxResults」回归；四段降级链（500 → 超时 → 成功）与失败原因回传；
空结果不算错误；全失败语义；时效参数真的下发；真实 agent 回合调用 search；
网页读取的协议 / 内网 / 二进制 / 不可达域名边界；桌面端面板与试搜。

**已知限制**：免密钥引擎是 HTML 解析，站点改版会让解析失效——届时
`/api/search/status` 会立刻显示该引擎不可用，其余引擎继续工作；配 Tavily 密钥可获得
稳定的结构化结果。搜索引擎对高频抓取可能限流，本项目不做反爬对抗。
