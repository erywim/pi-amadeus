import type { CatalogEntry } from '@pi-amadeus/shared'

/**
 * 内置插件目录（「发现」页的数据源）。
 *
 * 参考 DeepSeek Harness 生态的组织方式：插件按 kind + category 分类，
 * 一份目录条目自带安装所需的全部内容（skill 正文 / prompt 模板 / 主题变量 / MCP 启动配置），
 * 大脑不需要联网拉市场索引——离线也能浏览与安装。
 *
 * 新增条目只改本文件；id 一经发布不可改名（已安装记录以 id 为主键）。
 */
export const PLUGIN_CATALOG: CatalogEntry[] = [
  // ============================ Skills ============================
  {
    id: 'code-review',
    kind: 'skill',
    name: '代码审查',
    description: '按「正确性 → 边界 → 可维护性」三层审查改动，先给结论再给证据。',
    details:
      '适合贴入 diff、文件或 PR 描述后让助手做一次结构化 review。\n输出固定为：结论（可合并 / 需修改 / 有风险）、逐条问题（位置 + 触发条件 + 影响）、建议改法。\n不会为了凑数编造问题；没有问题时会明确说明。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '开发',
    tags: ['代码', 'review', '质量'],
    icon: '🔍',
    accent: '#4658e5',
    skillMarkdown: `---
name: code-review
description: 当用户要求审查代码、review PR、评估改动风险或找 bug 时使用
---

# 代码审查

## 输出顺序

1. **结论**：可合并 / 需修改 / 有风险（一句话 + 理由）
2. **问题清单**：按严重程度排序，每条写清位置、触发条件、影响
3. **建议改法**：能给出具体代码或伪代码就给

## 审查层次

- 正确性：逻辑错误、空值/边界、并发与异步时序
- 安全：注入、越权、密钥泄漏、不可信输入
- 可维护性：命名、重复、职责混杂、无意耦合
- 测试：这次改动缺了哪个「撤掉修复就会挂」的验证

## 约束

- 只报有证据的问题，不臆测；不确定时写明「需要确认」
- 不把风格偏好当 bug
- 没有问题就直说没有问题
`
  },
  {
    id: 'weekly-report',
    kind: 'skill',
    name: '周报整理',
    description: '把零散的工作记录整理成结构化周报：进展、风险、下周计划。',
    details:
      '把这一周的提交、会议、聊天记录丢给助手，它会按「结果导向」重写：先写做成了什么，再写过程。\n适合直接发给团队或粘贴到飞书文档。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '效率',
    tags: ['周报', '写作', '总结'],
    icon: '📝',
    accent: '#0d9488',
    skillMarkdown: `---
name: weekly-report
description: 当用户要求写周报、整理本周工作、汇报进展时使用
---

# 周报整理

## 结构

1. **本周结果**：3-5 条，动词开头，写用户/业务能感知的变化
2. **进行中**：当前状态 + 预计完成时间
3. **风险与阻塞**：需要谁做什么
4. **下周计划**：按优先级排序，最多 5 条

## 规则

- 结果优先于过程：不写「参加了会议」，写「确定了 X 方案」
- 每条尽量带数字或可验证的产出
- 不确定的进展标注「待确认」，不替用户编造
- 默认中文，语气克制
`
  },
  {
    id: 'meeting-notes',
    kind: 'skill',
    name: '会议纪要',
    description: '把会议转写整理成决议、待办与责任人，自带缺失信息标注。',
    details:
      '适合处理语音转写或手打记录。会把「讨论过但没定」的内容单独列出来，避免把讨论当决议。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '效率',
    tags: ['会议', '纪要', '待办'],
    icon: '🗂️',
    accent: '#7c3aed',
    skillMarkdown: `---
name: meeting-notes
description: 当用户要求整理会议纪要、转写记录、提取待办时使用
---

# 会议纪要

## 输出

- **结论 / 决议**：已经拍板的事项，逐条写
- **待办**：事项 + 责任人 + 截止时间（缺失的写「待确认」）
- **待定**：讨论过但没有结论的问题
- **风险**：需要升级或额外资源的事项

## 规则

- 严格区分「讨论」与「决议」
- 不补写会上没说过的内容
- 人名、时间、数字逐字核对原始记录
`
  },
  {
    id: 'paper-reader',
    kind: 'skill',
    name: '论文速读',
    description: '用「问题 → 方法 → 证据 → 局限」四段式拆解论文。',
    details: '适合 arXiv / PDF 文本。先给 5 行摘要，再展开方法与实验，最后给可复现性评估。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '研究',
    tags: ['论文', '阅读', '研究'],
    icon: '📄',
    accent: '#2563eb',
    skillMarkdown: `---
name: paper-reader
description: 当用户要求读论文、总结 arXiv、解释研究方法时使用
---

# 论文速读

## 四段式

1. **问题**：这篇论文要解决什么，之前的方法差在哪
2. **方法**：核心思路 + 关键公式/架构（用直白语言解释）
3. **证据**：数据集、基线、主要实验结论（带数字）
4. **局限**：作者承认的 + 你看出来的

## 输出

- 开头先给 5 行以内的 TL;DR
- 术语首次出现时给中文解释
- 区分「论文声称」与「实验支持」
`
  },
  {
    id: 'sql-tuner',
    kind: 'skill',
    name: 'SQL 优化',
    description: '从执行计划、索引与数据分布三处定位慢查询。',
    details: '贴入 SQL、表结构和 EXPLAIN 结果即可。会先判断瓶颈类型，再给改写与索引建议。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '开发',
    tags: ['SQL', '性能', '数据库'],
    icon: '⚡',
    accent: '#d97706',
    skillMarkdown: `---
name: sql-tuner
description: 当用户要求优化 SQL、分析慢查询、设计索引时使用
---

# SQL 优化

## 步骤

1. 读执行计划：全表扫描、回表、临时表、文件排序
2. 判断瓶颈：过滤性差 / 索引失效 / 关联顺序 / 数据倾斜
3. 给方案：SQL 改写、索引、分区、缓存，按收益排序
4. 给验证：EXPLAIN 前后对比、预期扫描行数

## 约束

- 索引建议必须说明列顺序与理由
- 提醒写放大与存储成本
- 不假设表规模；缺失信息就明确问
`
  },
  {
    id: 'prd-writer',
    kind: 'skill',
    name: '需求文档',
    description: '把一句话想法展开成可评审的 PRD：目标、范围、流程、验收。',
    details: '会主动区分「本期做」和「不做」，并给可测试的验收标准，避免 PRD 写成愿望清单。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '产品',
    tags: ['PRD', '产品', '需求'],
    icon: '📐',
    accent: '#db2777',
    skillMarkdown: `---
name: prd-writer
description: 当用户要求写需求文档、PRD、功能方案时使用
---

# 需求文档

## 结构

1. 背景与目标（可量化）
2. 用户与场景
3. 范围：本期做 / 本期不做
4. 交互流程（文字或 Mermaid）
5. 验收标准（可测试）
6. 风险与依赖

## 规则

- 一个需求只解决一个用户问题
- 验收标准写成「给定…当…则…」
- 不确定的决策列为「待定」，给出选项与推荐
`
  },
  {
    id: 'translate-polish',
    kind: 'skill',
    name: '翻译润色',
    description: '中英日互译，保留术语与语气，先给译文再给改动说明。',
    details: '适合技术文档与产品文案。术语不一致时会列出来让用户选，而不是各译各的。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '写作',
    tags: ['翻译', '写作', '日语'],
    icon: '🌐',
    accent: '#0891b2',
    skillMarkdown: `---
name: translate-polish
description: 当用户要求翻译、润色、本地化文案时使用
---

# 翻译润色

## 输出

1. 译文（只给最终版本）
2. 关键术语对照（原文 → 译文）
3. 需要确认的语气/文化差异（如有）

## 规则

- 技术术语优先行业通用译法，不确定时保留原文并标注
- 不逐字硬译；保持原文信息量
- 中日互译注意敬语层级与省略主语的还原
- 用户指定风格（正式/口语/营销）时严格遵循
`
  },
  {
    id: 'mermaid-diagram',
    kind: 'skill',
    name: '图表生成',
    description: '把流程、架构、时序讲成 Mermaid 图，直接可渲染。',
    details:
      '适合把一段文字描述转成流程图、时序图、状态机或 ER 图。输出带标题的 Mermaid 代码块，Amadeus 的聊天窗可直接渲染。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '效率',
    tags: ['图表', 'Mermaid', '可视化'],
    icon: '📊',
    accent: '#16a34a',
    skillMarkdown: `---
name: mermaid-diagram
description: 当用户要求画流程图、架构图、时序图、状态机或 ER 图时使用
---

# 图表生成

## 规则

- 先问清楚要表达的重点（流程 / 时序 / 状态 / 数据关系），没问就先按最可能的类型画
- 节点文案短，避免换行与特殊符号
- 一张图只讲一件事；复杂系统拆成多张
- 输出 \`\`\`mermaid 代码块，图类型后给 title

## 类型选择

- 步骤与分支 → flowchart
- 多方交互顺序 → sequenceDiagram
- 状态迁移 → stateDiagram-v2
- 数据表关系 → erDiagram
- 时间线 → timeline
`
  },

  // ============================ Prompts ============================
  {
    id: 'explain-feynman',
    kind: 'prompt',
    name: '费曼式讲解',
    description: '用大白话 + 类比 + 反例讲清一个概念，最后给自测题。',
    details: '适合学习新概念。会先给一句话定义，再用生活类比展开，最后指出常见误解。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '学习',
    tags: ['讲解', '学习'],
    icon: '🧠',
    accent: '#6366f1',
    prompt:
      '请用费曼学习法讲解「（替换成你要学的概念）」：\n1. 先用一句大白话定义它\n2. 用一个日常类比展开\n3. 指出一个常见误解或反例\n4. 给 3 道自测题（附答案）\n要求：不堆术语；必须出现具体例子。'
  },
  {
    id: 'refactor-plan',
    kind: 'prompt',
    name: '重构方案',
    description: '给出一份可分步落地、每步都可回滚的重构计划。',
    details: '把目标代码或模块描述贴进来，输出按风险排序的改造步骤，每步包含验证方式与回滚点。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '开发',
    tags: ['重构', '架构'],
    icon: '🧱',
    accent: '#0f766e',
    prompt:
      '请为下面的代码/模块设计重构方案：\n（粘贴代码或描述）\n\n输出要求：\n1. 当前问题按严重程度排序，每条给证据\n2. 目标结构（职责边界）\n3. 分步改造计划：每步可独立提交、可回滚，并写明验证方式\n4. 明确不改的部分与原因\n不要一次性大爆炸式重写。'
  },
  {
    id: 'competitive-analysis',
    kind: 'prompt',
    name: '竞品分析',
    description: '按用户、能力、商业模式、差异点四维拆竞品。',
    details: '适合产品立项前的快速扫描。会明确标注哪些是公开事实、哪些是推断。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '产品',
    tags: ['竞品', '分析'],
    icon: '🔭',
    accent: '#0284c7',
    prompt:
      '请对「（产品/赛道）」做一份竞品分析：\n1. 列出 3-5 个主要竞品\n2. 四维对比：目标用户 / 核心能力 / 商业模式 / 差异点\n3. 用表格呈现；事实与推断分开标注\n4. 给出我们的机会点与风险\n不确定的数据写「未验证」，不要编造。'
  },
  {
    id: 'trip-plan',
    kind: 'prompt',
    name: '旅行规划',
    description: '按天给路线、交通、预算与备选方案。',
    details: '告诉目的地、天数、预算和偏好即可。行程会标注步行距离与预约要求。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '生活',
    tags: ['旅行', '规划'],
    icon: '🧭',
    accent: '#ea580c',
    prompt:
      '帮我规划一次旅行：\n目的地：\n天数：\n人数：\n预算：\n偏好（美食/自然/人文/购物）：\n\n输出：按天行程（上午/下午/晚上）、交通方式与耗时、餐饮推荐、预算估算、需要提前预约的项目、雨天备选。'
  },
  {
    id: 'interview-coach',
    kind: 'prompt',
    name: '面试模拟',
    description: '扮演面试官逐题追问，结束后给评分与改进建议。',
    details: '选择岗位与级别，助手会一次问一题，等你回答后追问或换题，最后给结构化反馈。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '职业',
    tags: ['面试', '职业'],
    icon: '🎤',
    accent: '#9333ea',
    prompt:
      '请扮演「（岗位）」的资深面试官，对我进行模拟面试。\n规则：\n- 一次只问一个问题，等我回答后再追问或换题\n- 共 5 题，从基础到场景设计\n- 最后给出：各题评分（1-5）、亮点、需要补的知识点、一句话总评\n现在开始第一题。'
  },
  {
    id: 'commit-message',
    kind: 'prompt',
    name: '提交信息',
    description: '把 diff 概括成符合团队规范的提交信息。',
    details: '贴入 git diff 或改动说明，输出 subject + body，body 写清改了什么、怎么验证、没跑什么。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '开发',
    tags: ['Git', '提交'],
    icon: '🧾',
    accent: '#475569',
    prompt:
      '请根据下面的改动写一条提交信息：\n（粘贴 git diff 或改动说明）\n\n格式：\n- 主题：<范围>: <用户能感知的行为变化>（中文，不超过 50 字）\n- 正文：改了什么 / 跑了哪些验证（命令与结果）/ 没跑什么\n一个提交只做一件事；如果改动混杂，先建议拆分。'
  },

  // ============================ Themes ============================
  {
    id: 'theme-steins-gate',
    kind: 'theme',
    name: '命运石之门',
    description: '深空底色 + 青色荧光，实验室仪表的冷峻感。',
    details: '在「插件 → 主题」里启用后立即生效，可随时切回默认主题。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '主题',
    tags: ['深色', '赛博'],
    icon: '🧪',
    accent: '#00e5ff',
    themeVars: {
      '--background': '#050a0f',
      '--foreground': '#e6edf3',
      '--card': '#0d131b',
      '--card-foreground': '#e6edf3',
      '--primary': '#00e5ff',
      '--primary-foreground': '#04141a',
      '--muted': '#121a24',
      '--muted-foreground': '#8b98a5',
      '--accent': '#0f2027',
      '--accent-foreground': '#e6edf3',
      '--destructive': '#ff4d6d',
      '--border': '#1c2530',
      '--ring': '#00e5ff',
      '--sidebar': '#0a1018',
      '--surface': '#0d131b',
      '--surface-soft': '#121a24',
      '--stage': '#050a0f',
      '--line-strong': '#2a3646',
      '--ink-2': '#8b98a5',
      '--mint': '#00b84d',
      '--accent-soft': 'rgba(0, 229, 255, 0.12)',
      '--accent-ink': '#04141a'
    }
  },
  {
    id: 'theme-paper-moon',
    kind: 'theme',
    name: '纸月',
    description: '暖纸底 + 琥珀主色，长时间阅读不刺眼。',
    details: '浅色主题，适合白天与文档阅读场景。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '主题',
    tags: ['浅色', '阅读'],
    icon: '🌙',
    accent: '#b45309',
    themeVars: {
      '--background': '#f7f3ea',
      '--foreground': '#2b241c',
      '--card': '#fffdf8',
      '--card-foreground': '#2b241c',
      '--primary': '#b45309',
      '--primary-foreground': '#fffaf0',
      '--muted': '#efe8db',
      '--muted-foreground': '#7a6a55',
      '--accent': '#f3e7d3',
      '--accent-foreground': '#2b241c',
      '--destructive': '#c2410c',
      '--border': '#e3d9c8',
      '--ring': '#b45309',
      '--sidebar': '#f7f3ea',
      '--surface': '#fffdf8',
      '--surface-soft': '#f2ece1',
      '--stage': '#f2ede4',
      '--line-strong': '#d6c9b4',
      '--ink-2': '#5a4b3a',
      '--mint': '#0f766e',
      '--accent-soft': '#f6ead6',
      '--accent-ink': '#fffaf0'
    }
  },
  {
    id: 'theme-deep-sea',
    kind: 'theme',
    name: '深海',
    description: '藏青底 + 水蓝高光，安静克制的暗色。',
    details: '暗色主题，蓝色系，适合夜间长时间对话。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '主题',
    tags: ['深色', '蓝色'],
    icon: '🌊',
    accent: '#4cc9f0',
    themeVars: {
      '--background': '#071019',
      '--foreground': '#dbe9f4',
      '--card': '#0c1a26',
      '--card-foreground': '#dbe9f4',
      '--primary': '#4cc9f0',
      '--primary-foreground': '#04121a',
      '--muted': '#101f2d',
      '--muted-foreground': '#8298aa',
      '--accent': '#12293a',
      '--accent-foreground': '#dbe9f4',
      '--destructive': '#f87171',
      '--border': '#1b3042',
      '--ring': '#4cc9f0',
      '--sidebar': '#08141e',
      '--surface': '#0c1a26',
      '--surface-soft': '#101f2d',
      '--stage': '#050d15',
      '--line-strong': '#28455c',
      '--ink-2': '#a7bccd',
      '--mint': '#2dd4bf',
      '--accent-soft': 'rgba(76, 201, 240, 0.14)',
      '--accent-ink': '#04121a'
    }
  },
  {
    id: 'theme-cyber-lime',
    kind: 'theme',
    name: '赛博青柠',
    description: '近黑底 + 荧光青柠，终端味儿的暗色。',
    details: '暗色主题，绿色荧光，适合终端与代码场景。',
    author: 'Amadeus',
    version: '1.0.0',
    category: '主题',
    tags: ['深色', '终端'],
    icon: '🟢',
    accent: '#b7ff3c',
    themeVars: {
      '--background': '#080c08',
      '--foreground': '#e7f3df',
      '--card': '#0e140e',
      '--card-foreground': '#e7f3df',
      '--primary': '#b7ff3c',
      '--primary-foreground': '#0a1203',
      '--muted': '#131b13',
      '--muted-foreground': '#8fa08a',
      '--accent': '#172217',
      '--accent-foreground': '#e7f3df',
      '--destructive': '#ff6b6b',
      '--border': '#1e2b1e',
      '--ring': '#b7ff3c',
      '--sidebar': '#0a100a',
      '--surface': '#0e140e',
      '--surface-soft': '#131b13',
      '--stage': '#060a06',
      '--line-strong': '#2c3d2c',
      '--ink-2': '#b3c4ad',
      '--mint': '#7ee787',
      '--accent-soft': 'rgba(183, 255, 60, 0.12)',
      '--accent-ink': '#0a1203'
    }
  },

  // ============================ MCP ============================
  {
    id: 'mcp-filesystem',
    kind: 'mcp',
    name: '文件系统',
    description: '让助手读写指定目录下的文件（官方 MCP 参考服务）。',
    details:
      '安装时需要填写一个本机目录。助手只能访问该目录及其子目录。\n由 npx 启动 @modelcontextprotocol/server-filesystem，首次安装需要能访问 npm。',
    author: 'Model Context Protocol',
    version: '1.0.0',
    category: 'MCP',
    tags: ['文件', '本地'],
    icon: '📁',
    accent: '#0ea5e9',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    mcp: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      fields: [
        {
          key: 'directory',
          label: '允许访问的目录',
          hint: '绝对路径，例如 /Users/you/Documents/notes',
          required: true,
          target: 'arg',
          default: ''
        }
      ]
    }
  },
  {
    id: 'mcp-memory',
    kind: 'mcp',
    name: '知识图谱记忆',
    description: '基于知识图谱的长期记忆，跨会话记住实体与关系。',
    details: '官方参考服务，数据保存在本机。安装后助手可写入与查询记忆节点。',
    author: 'Model Context Protocol',
    version: '1.0.0',
    category: 'MCP',
    tags: ['记忆', '知识图谱'],
    icon: '🕸️',
    accent: '#8b5cf6',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    mcp: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory']
    }
  },
  {
    id: 'mcp-sequential-thinking',
    kind: 'mcp',
    name: '结构化思考',
    description: '把复杂问题拆成可回溯的思考步骤。',
    details: '官方参考服务。适合规划、拆解与需要显式推理链的任务。',
    author: 'Model Context Protocol',
    version: '1.0.0',
    category: 'MCP',
    tags: ['推理', '规划'],
    icon: '🧩',
    accent: '#f59e0b',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    mcp: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
    }
  },
  {
    id: 'mcp-github',
    kind: 'mcp',
    name: 'GitHub',
    description: '搜索仓库、读写 issue 与 PR。',
    details:
      '需要 GitHub Personal Access Token（只勾选需要的权限）。\n令牌保存在大脑服务的本地 SQLite，不会回传到界面。',
    author: 'Model Context Protocol',
    version: '1.0.0',
    category: 'MCP',
    tags: ['GitHub', '代码'],
    icon: '🐙',
    accent: '#334155',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    mcp: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      fields: [
        {
          key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
          label: 'GitHub Token',
          hint: 'fine-grained token，至少需要 repo 读取权限',
          required: true,
          secret: true,
          target: 'env',
          default: ''
        }
      ]
    }
  },
  {
    id: 'mcp-everything',
    kind: 'mcp',
    name: 'MCP 演示服务',
    description: '官方 everything 测试服务：验证 MCP 链路是否打通。',
    details: '提供 echo、add、长任务等示例工具，适合排查 MCP 连接问题。',
    author: 'Model Context Protocol',
    version: '1.0.0',
    category: 'MCP',
    tags: ['测试', '调试'],
    icon: '🧪',
    accent: '#10b981',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    mcp: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything']
    }
  },
  {
    id: 'mcp-fetch',
    kind: 'mcp',
    name: '网页抓取',
    description: '抓取网页并转成 Markdown，补足模型的知识盲区。',
    details: '需要本机安装 uv（uvx 命令）。安装后可让助手读取指定 URL 的正文。',
    author: 'Model Context Protocol',
    version: '1.0.0',
    category: 'MCP',
    tags: ['网页', '抓取'],
    icon: '🕸️',
    accent: '#06b6d4',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    mcp: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch']
    }
  }
]

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return PLUGIN_CATALOG.find((entry) => entry.id === id)
}
