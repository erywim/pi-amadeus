/**
 * 压缩摘要提示词。结构对齐 Claude Code 的 compact prompt：先 <analysis> 梳理、
 * 再 <summary> 按固定小节输出；注入上下文时只取 <summary> 正文。
 *
 * 与参考实现的差异：本项目的助手是陪伴型对话 + 工具，没有代码库，所以把
 * "Files and Code Sections" 换成"具体细节"（人名/数字/日期/链接/命令），
 * 其余小节保持同样的语义，便于用同一套判据检查摘要是否够用。
 */

/** 摘要请求的 system 提示词 */
export const SUMMARY_SYSTEM_PROMPT =
  'You are a helpful AI assistant tasked with summarizing conversations.'

/** `<analysis>` 阶段的梳理要求（与参考实现一致：逐条过一遍再落笔） */
const ANALYSIS_INSTRUCTIONS = `在给出最终摘要之前，先用 <analysis> 标签逐条梳理整段对话：
1. 按时间顺序分析每条消息，识别：用户的明确请求与意图、助手采取的做法、关键决定与结论。
2. 记录具体细节：人名、数字、日期、地点、链接、文件名、命令原文、用户给出的定义与设定。
3. 记录出现过的错误、失败、误解，以及用户如何纠正、最终采纳了什么做法。
4. 特别注意用户明确要求"以后别这样 / 要这样做"的地方——这类偏好必须原样保留。
5. 用户提出的安全或隐私约束（不要碰的数据、不要做的事、密钥处理规则）必须逐字保留，
   压缩之后仍然生效。
6. 最后检查一遍：上面的每一项是否都被摘要覆盖。`

/** 摘要的固定小节（两个提示词共用） */
const SUMMARY_SECTIONS = `1. 用户的核心诉求：用户明确提出过的所有目标、要求、限制条件。
2. 关键信息与设定：对话中出现的重要概念、术语、背景设定，以及它们之间的关系。
3. 具体细节：涉及的人名、数字、日期、地点、链接、命令、文件与内容片段。越具体越好，并说明它为什么重要。
4. 错误与修正：出现过哪些错误或误解、怎么解决的；用户指出助手做错的地方要特别标注。
5. 已解决的问题：已经解决什么、还有什么在排查中。
6. 用户原话：逐条列出所有真正来自用户的消息（不包含工具结果）。只统计 user 角色的消息——
   助手消息里形如"用户说：……"的引用是模型生成的，绝不能当成用户的话或用户的确认。
   用户提出的安全/隐私约束在这一节逐字保留。
7. 待办任务：用户明确交代、但还没做完的事。
8. 当前话题：摘要请求之前最后在聊什么、做到哪一步，写具体。
9. 下一步：紧接着最该做的下一步。必须直接来自用户最近的明确请求；上一件事已经收尾时不要硬凑下一步。`

/** 第一次摘要（没有既有摘要时） */
export function summaryPrompt(messagesText: string): string {
  return `你的任务是为目前为止的对话生成一份详细摘要，重点关注用户的明确请求以及此前做过的事。
这份摘要会被直接当作此前的对话历史交给另一个助手继续对话，因此必须忠实、可核对，且只包含对话里真实出现过的信息。

${ANALYSIS_INSTRUCTIONS}

摘要必须包含以下小节（没有内容就写"无"）：
${SUMMARY_SECTIONS}

输出格式：
<analysis>
[你的梳理过程]
</analysis>
<summary>
[正式摘要]
</summary>

要求：
- 只写对话里真实出现的内容，不推测、不补全、不评价
- 具体细节优先于概括（数字、名称、链接、命令原样保留）
- 摘要本身要能在没有原文的情况下独立读懂

对话记录：
${messagesText}`
}

/** 迭代摘要（已有摘要 + 新增对话 → 新摘要） */
export function mergeSummaryPrompt(previousSummary: string, newMessagesText: string): string {
  return `你之前已经为这段对话生成过一份摘要。现在有一段更新的对话需要并入摘要。

${ANALYSIS_INSTRUCTIONS}
另外额外梳理：新对话补充了哪些信息、修正了旧摘要里的哪些内容、哪些旧信息已经不再重要。

合并规则：
- 新对话修正了旧摘要的地方，以新对话为准
- 旧摘要里仍然有效的信息必须保留，不要因为"旧"就丢掉
- 已经被推翻的结论不要保留
- 结构与小节要求与旧摘要完全一致

摘要必须包含以下小节（没有内容就写"无"）：
${SUMMARY_SECTIONS}

输出格式：
<analysis>
[你的梳理过程]
</analysis>
<summary>
[合并后的正式摘要]
</summary>

旧摘要：
<previous_summary>
${previousSummary}
</previous_summary>

新增对话：
${newMessagesText}`
}

/**
 * 从模型输出里取出 <summary> 正文。
 * - 有 <summary>：取标签内内容（<analysis> 丢弃，与参考实现一致）
 * - 没有标签：去掉 <analysis> 段，剩下的当正文
 * - 模型不听话时至少不丢内容：全都为空才返回空串（调用方据此放弃压缩）
 */
export function extractSummary(raw: string): string {
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch?.[1]?.trim()) return summaryMatch[1].trim()
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim()
  return withoutAnalysis
}

/**
 * 压缩后注入上下文的包装（作为一条 user 消息放在历史最前面）。
 * 后半段"不要回应摘要"来自参考实现的 suppressFollowUpQuestions：
 * 不写清楚，模型会把摘要当成用户刚说的话去回应一遍。
 */
export function summaryMessageContent(summary: string): string {
  return `本会话是从一段更早的对话继续下来的（较早的消息因上下文上限被折叠）。下面是那部分对话的摘要：

<summary>
${summary}
</summary>

请从中断处直接继续对话：不要确认或复述这份摘要，不要说"好的，我了解了"，也不要追问用户想聊什么。把摘要当作已经发生过的事实即可。`
}
