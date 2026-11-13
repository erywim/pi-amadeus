# 效率与工作区（命令面板 / 只读工作区 / 排队 / 分支树 / 改动卡）

文本模式在「会话 + 运行图 + 终端 + 工件」之外，补了一组日常高频的效率能力。
所有数据都来自真实来源：文件树来自磁盘、Git 状态来自 `git status`、改动卡来自
回合前后两次真实快照的差集、导出内容来自落库消息。没有数据时界面不显示，不补假数据。

## 1. 命令面板（⌘/Ctrl+K）

- 一个输入框搜四类结果：动作、页面、会话、消息正文（消息走服务端 `LIKE`，350ms 防抖，至少 2 字）。
- 空查询显示动作（新建会话 / 主题切换 / 设置 / 分支树 / 导出 / 快捷键）与最近 5 个会话。
- ↑↓ 选择、Enter 打开、Esc 关闭；结果变化时选中项自动收回有效范围。

## 2. 只读工作区（右侧面板「文件」）

- **文件树**：优先用 `git ls-files --cached --others --exclude-standard`（天然尊重
  `.gitignore`），非 Git 目录回退到有界遍历（深度 7、跳过 `node_modules` 等重型目录）。
- **文件正文**：单文件最多读 512KB，二进制（含 NUL）不显示正文；弹窗只读、可复制。
- **变更**：`git status --porcelain=v1 -z -uall`，未跟踪文件合成「整份新增」的 diff。
- **安全**：路径做词法 + `realpath` 两层越界校验；`.env*`、`id_rsa`、`*.pem` 等敏感文件
  既不进文件树也不出现在变更列表；`.multica/` 运行时目录同样排除。
  直接请求正文或 diff 也执行相同过滤，符号链接不能绕过；diff 只接受单文件字面路径，不展开目录或 Git pathspec。
  普通文件与指向普通文件的区内链接仍可读，已删除的普通文件仍可查看 Git diff。
- **只读**：不提供任何写入接口——终端命令仍走 bash 工具与确认卡。

接口：`GET /api/workspace/{info,tree,file,git,diff,search}`，根目录由 `WORKSPACE_DIR`
指定（默认与 `BASH_TOOL_CWD` 一致）。

## 3. 输入区增强

- **`@` 文件引用**：输入 `@` 后按文件名搜工作区，选中后插入 `@路径` 文本。
  只插入路径，不把文件内容塞进上下文——模型需要内容时会自己用工具读取。
- **内置斜杠命令**：`/new` `/tree` `/export` `/theme` `/settings` `/memory`
  `/knowledge` `/automations` `/dashboard`，直接执行界面动作；插件快捷指令排在其后。
- **生成中排队**：流式期间按 Enter / 点队列按钮把消息放进队列（显示条数与内容），
  本回合**正常结束**后自动发下一条；停止或失败不自动继续，交给用户决定（队列条上可手动发送、清空、单条移除）。
- **上下文读数**：按可见消息正文估算（中日文约 1 token/字，其余 3.6 字符/token），
  模型窗口按模型名匹配常见上限；仅作刻度参考，不含系统提示、工具结果与附件正文。

## 4. 分支树弹窗

- `GET /api/sessions/:id/tree` 返回完整消息树（所有分支）与活跃叶。
- 每个节点显示角色、预览、`分支 n/m`；当前活跃路径高亮，叶子标「当前」，其余标「旧分支」。
- 点旧分支 = `POST /api/sessions/:id/active-leaf`，把活跃叶切到该分支的最新后代；不删除任何消息。

## 5. 回合改动卡

- 桌面端回合在开始与结束各取一次 `git status` 快照；差集（新出现或状态变化）写入该条
  助手消息的 `changed_files`，界面在回复下方显示「本回合改动 N 个文件」折叠卡。
- 点文件名 → 右侧工作区面板切到「变更」并打开该文件的未提交 diff。
- 快照拿不到（非 Git 目录）或没差集时不显示卡片——`null`（未知）与「没有变化」严格区分。

## 6. 会话归档与快捷键速查

- 归档：`PATCH /api/sessions/:id { archived }`，不删除、不刷新 `updated_at`；
  侧栏默认隐藏，底部「已归档 N」分区展开后可恢复。
- 快捷键速查：⌘/Ctrl+/ 或命令面板里的「快捷键」，列出所有已实现的键位（速查表本身不新增绑定）。

## 7. 代码地图

| 位置 | 职责 |
| --- | --- |
| `services/brain/src/workspace.ts` | 文件树 / 正文 / Git 状态与 diff / 文件名搜索 / 回合快照与差集 |
| `services/brain/src/routes/workspace.ts` | `/api/workspace/*` 只读接口 |
| `services/brain/src/db.ts` | `messages.changed_files`、`sessions.archived` 与迁移 |
| `services/brain/src/agentTurn.ts` | 回合前后快照，结果带 `changedFiles` |
| `services/brain/src/routes/sessions.ts` | `/tree`、`/active-leaf`、`archived` PATCH |
| `apps/desktop/src/renderer/src/features/command-palette/` | 命令面板 |
| `apps/desktop/src/renderer/src/features/workbench/WorkspaceView.tsx` | 文件树 / 变更 / 预览弹窗 |
| `apps/desktop/src/renderer/src/features/chat/BranchTreeDialog.tsx` | 分支树 |
| `apps/desktop/src/renderer/src/features/chat/ChangedFilesCard.tsx` | 回合改动卡 |
| `apps/desktop/src/renderer/src/features/chat/ContextMeter.tsx` | 上下文估算读数 |
| `apps/desktop/src/renderer/src/features/shortcuts/ShortcutsDialog.tsx` | 快捷键速查 |
| `apps/desktop/src/renderer/src/lib/exportSession.ts` | 会话导出 Markdown |
| `apps/desktop/src/renderer/src/stores/sessionStore.ts` | 排队、归档、分支切换 |
| `apps/desktop/src/renderer/src/stores/uiStore.ts` | 面板 / 弹窗 / diff 请求 |

## 8. 验证

```bash
# 直接 file/diff 隐私过滤与符号链接回归（完全隔离，不需要启动应用）
node scripts/e2e-privacy-contract.mjs

npm run dev:brain
npx --prefix apps/desktop electron-vite dev --remoteDebuggingPort 9333

CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-ui-borrowed.mjs          # 22 项
CDP_HTTP=http://127.0.0.1:9333 node scripts/e2e-turn-changes-archive.mjs # 11 项
```

`e2e-ui-borrowed.mjs` 覆盖命令面板、工作区文件树/正文/Git/越界拒绝/敏感文件排除、
内置斜杠命令、`@` 引用、真实排队、上下文读数、命令面板消息搜索、分支树切换、
Markdown 导出（真实下载文件）、完成通知开关。

`e2e-turn-changes-archive.mjs` 覆盖：模型用 bash 真实写文件 → 改动卡出现 → 点文件名
打开 diff 且内容与磁盘一致；干净回合不新增改动卡；快捷键速查打开/键位/关闭/命令面板入口；
归档 → 服务端状态一致 → 主列表移除 → 已归档分区可见 → 恢复回主列表。
