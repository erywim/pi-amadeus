# 消息附件与分支树

文本模式支持图片 / 语音 / 文件附件，并把「编辑后重发」升级成真正的消息树：
编辑与重新生成都会新建分支，旧分支保留、可随时切换。

## 1. 附件

### 数据与落盘

- 附件本体写到 `services/brain/data/media`（`MEDIA_DIR` 可覆盖），文件名是随机 UUID；
  原始文件名只作展示，不参与路径（防路径穿越）。
- 数据库 `message_media` 保存元数据与 `extracted_text`；消息列表只回传
  `{ id, kind, name, mimeType, size, url }`，磁盘路径与抽取文本不出接口。
- `GET /api/media/:id` 返回原始字节（随机 id，无目录遍历）。
- 单条消息最多 6 个附件；图片 10MB / 语音 25MB / 文件 20MB。

### 进入模型

- **文本文件**（text/*、json、md、csv、常见代码后缀）：UTF-8 抽取，单文件最多 20k 字、整条消息 40k 字。
- **语音**：配置了 Whisper（`WHISPER_*`）时转写，转写文本与原文一起入库；未配置则明确标「未转写」。
- **图片**：只有目标模型支持视觉输入时才作为 image content 发送；纯文本模型会收到
  「用户发送了 N 张图片，但当前模型不支持图像输入」的说明，不静默丢失。
- 文本附件与语音转写会进入后续回合的上下文（从 `message_media.extracted_text` 重建）；
  历史图片不重复发送，只保留占位说明，避免每回合重复传大图。

### 界面

- 输入区「+ 附件」、拖拽、粘贴图片都可以添加；图片显示缩略图，其它文件显示名称/大小。
- 用户消息渲染图片网格、音频播放器与文件下载卡；刷新后从 `/api/media/<id>` 重新加载。
- 附件与消息同批落库：模型失败时附件与用户消息仍在，可直接重试。

## 2. 分支树

### 结构

- `messages.parent_id` 构成树；`sessions.active_leaf_id` 指向当前正在看的叶子。
- 读取消息时先从活跃叶沿 `parent_id` 回溯到根，得到当前分支路径（递归 CTE），再按时间排序。
- 追加消息时：用户消息接到当前活跃叶之后；助手回复接到该用户消息之后；两者都会更新活跃叶。
- 旧库迁移：首次启动把每个会话的线性消息按时间补成父子链，活跃叶设为最后一条（`messages_tree_v1` 标记只跑一次）。

### 编辑 / 重新生成

- **编辑用户消息**：不修改原消息、不删除后续消息；新用户消息作为原消息的兄弟节点写入，
  历史只读到共同父节点，然后跑回合。旧分支完整保留。
- **重新生成**：旧助手回复保留；新回复作为同一用户消息的另一个子节点写入，并成为活跃叶。
- 两条路径失败时都不会破坏旧分支（旧消息从未被删除）。

### 切换

- 消息返回 `parentId / branchIndex / branchCount`；界面在消息 meta 显示 `‹ 1/2 ›`。
- `POST /api/sessions/:id/branch { userId, messageId, direction }` 找到兄弟节点，
  沿最新子节点走到该分支叶子并设为活跃叶；界面随后回读消息路径。
- 分支切换不改变会话标题、指标或记忆；隐藏分支仍参与全文搜索。

### 约束

- 当前只做「消息树 + 单活跃路径」，不做 Git 式跨会话合并；
- `messageCount` 统计树中全部消息（含隐藏分支），因此可能大于当前路径长度；
- 删除会话会级联删除所有分支与附件。

## 3. 代码地图

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/attachment.ts` | 附件类型与大小/字数上限 |
| `packages/shared/src/session.ts` | Message 的 parent/branch/attachments 字段 |
| `services/brain/src/media.ts` | 附件保存、文本抽取、语音转写、对外 URL |
| `services/brain/src/routes/media.ts` | `/api/media/:id` |
| `services/brain/src/db.ts` | `message_media`、`parent_id`、`active_leaf_id`、分支查询 |
| `services/brain/src/conversation.ts` | 附件上下文、分支父亲、finishTurn 追加子节点 |
| `services/brain/src/routes/chat.ts` | 附件解析、编辑/重新生成的分支语义 |
| `services/brain/src/routes/sessions.ts` | 消息路径、分支切换接口 |
| `apps/desktop/src/renderer/src/features/chat/Composer.tsx` | 附件选择/粘贴/拖拽与待发送列表 |
| `.../features/chat/MessageBubble.tsx` | 附件渲染与分支切换器 |
| `.../stores/sessionStore.ts` | 附件发送、分支切换、回合后回读 |

## 4. 验证

```bash
npm run dev:brain
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-attachments-branches.mjs
```

`e2e-attachments-branches.mjs` 覆盖：附加文本+图片、真实模型读取文本附件、用户消息附件渲染、
服务端附件元数据与媒体字节、刷新后重渲染、编辑生成 2/2 分支、切回 1/2 再切回 2/2、
重新生成产生助手 2/2 分支并可切回。全部在真实 Electron 页面与真实模型回合上运行。
