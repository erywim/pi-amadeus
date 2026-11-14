# 知识库（Knowledge）

参考常见的本地知识库设计：用户导入自己的文档，
聊天时模型通过 `search_knowledge` 工具检索**真实原文片段**再回答。
没有向量数据库依赖，也没有云端上传——文档只存在本机 SQLite。

## 1. 职责与边界

- 存：知识库 → 文档 → 分块（`knowledge_bases` / `knowledge_docs` / `knowledge_chunks`）。
- 取：中文按 2-gram、英文按词切分，TF-IDF 打分，返回最相关的 4 个片段（带上文档名与分数）。
- 用：回合开始时把知识库清单写进 system prompt；模型按需调用 `search_knowledge`。
  没建过知识库的用户不会看到这个工具。
- 不做：embedding / 向量检索、PDF / DOCX 解析、OCR、增量索引、跨用户共享。
  这些是已知取舍，不是隐藏行为——导入二进制文件会明确拒绝。

## 2. 导入路径

| 入口 | 行为 |
| --- | --- |
| 粘贴文本 | `POST /api/knowledge/:id/docs`（JSON `{ name, content }`） |
| 上传文件 | 同接口 `multipart/form-data`（`file` + 可选 `name`），只接受纯文本（txt / md / json / csv / log …） |
| URL | `POST /api/knowledge/:id/import-url`，服务端抓取后去 script/style/标签、解码常见实体 |
| 删除 | 删除文档会一并删除它的分块；删除知识库会删除其下全部文档与分块（事务） |

约束：

- 单篇上限 400,000 字符；单块上限 900 字符，长段按 120 字符重叠硬切。
- 二进制判定：含 NUL 或大量不可打印控制字符 → 400，提示先转纯文本。
- URL 导入复用 `readPublicPage`：只允许公网 http(s)，解析全部 DNS 地址并固定到连接，
  每跳重定向重新校验（具体网段与代理限制见 [网页安全边界](web-search.md#6-安全边界)）。
- URL 抓取总超时 20 秒，最多保留 1,600,000 响应字节、400,000 正文字符；超限/截断返回 400，
  不持久化半篇文档。二进制 MIME 在读 body 前拒绝，谎报类型也检查魔数与文本质量。
- URL 文本尊重 BOM / HTTP / HTML meta charset，转换 HTML、解码合法实体；非法数字实体保留原文。
  抓取/读取失败返回可读原因，不落库；成功以最终 URL 作为来源（默认文档名也取最终地址）。

## 3. 检索算法（真实、可解释）

1. 查询与分块都做归一化：小写、非字母数字当分隔符、中文取相邻 2 字、英文取词。
2. 对每个查询词计算 TF（最多计 5 次，避免长文堆词）与 IDF：
   `idf = ln(1 + (N - df + 0.5) / (df + 0.5))`。
3. 分数 = Σ `(1 + ln(tf)) × idf`，再除以 `sqrt(max(40, 块长度))` 做长度归一。
4. 只返回分数 > 0 的前 N 条；没有命中就明确告诉模型「没有找到」，不补全内容。

局限：同义改写召回不到（没有 embedding）。这是刻意选择的零依赖方案，
检索结果全部是导入的原文，不会由模型生成。

## 4. 运行时路径

```
/api/chat → prepareTurn（注入知识库清单）
          → runAgentTurn（注册 search_knowledge 工具）
          → 模型调用工具 → searchKnowledge() → 原文片段回流
          → 模型基于片段回答 → 正常落库/指标/记忆提取
```

## 5. 关键状态与约束

- **知识库归属**：所有读写接口都带 `userId`；不属于该用户的知识库返回 403。
- **工具注册**：只有用户有至少一个知识库时才注册 `search_knowledge`，
  避免给没有资料的用户一个永远查不到东西的工具。
- **系统提示**：`knowledgeSystemPrompt()` 只列知识库名称与规模，不把全文塞进上下文。
- **删除是事务**：知识库/文档的删除在 `BEGIN/COMMIT` 里完成，失败回滚，不留半截分块。
- **导入失败不落半截**：文档行与分块在同一个事务里写入。

## 6. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/knowledge.ts` | 知识库/文档/检索命中的跨端类型 |
| `services/brain/src/knowledge/index.ts` | 切块、导入、TF-IDF 检索、`search_knowledge` 工具、系统提示 |
| `services/brain/src/routes/knowledge.ts` | `/api/knowledge*`，含文件/URL 导入与 HTML 转文本 |
| `services/brain/src/db.ts` | 三张表与事务化 CRUD |
| `services/brain/src/conversation.ts` | 回合准备时注入知识库提示 |
| `services/brain/src/agentTurn.ts` | 按用户注册知识库工具 |
| `apps/desktop/src/renderer/src/features/knowledge/KnowledgePage.tsx` | 知识库页：新建、导入、检索、删除 |
| `apps/desktop/src/renderer/src/stores/knowledgeStore.ts` | 页面状态与 API 调用 |

## 7. 验证

```bash
# URL 导入的安全与文本解码契约（全 mock fetch/DNS，无真实网络与用户数据）
node scripts/e2e-fetch-contract.mjs

# 终端 1：大脑
npm run dev:brain

# 终端 2：知识库 + 自动化 + 会话增强（不依赖桌面端）
node scripts/e2e-knowledge-automation.mjs

# 终端 3：桌面端页面
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-workspace.mjs
```

`e2e-knowledge-automation.mjs` 覆盖：创建/导入/切块/检索、真实模型调用 `search_knowledge`
并引用原文、跨库隔离、URL 导入去标签、删除文档后不再命中。
`e2e-workspace.mjs` 覆盖桌面端新建/粘贴导入/检索预览/删除文档。
