import { completeText, type LlmTarget } from './llm.ts'

/** 首轮问答后异步生成会话标题（失败返回 null，不阻塞主流程） */
export async function generateTitle(
  target: LlmTarget,
  userText: string,
  assistantText: string
): Promise<string | null> {
  try {
    const out = await completeText(
      target,
      {
        systemPrompt: '你是标题生成器。用不超过 12 个汉字概括这段对话的主题，直接输出标题本身，不要引号、标点或任何解释。',
        messages: [
          {
            role: 'user',
            content: `用户：${userText.slice(0, 200)}\n助手：${assistantText.slice(0, 400)}`,
            timestamp: Date.now()
          }
        ]
      },
      // deepseek-v4-pro 是推理模型：小预算会被 thinking 吃光导致空输出，给足余量
      { temperature: 0.3, maxTokens: 512 }
    )
    const title = out
      .trim()
      .replace(/^["'「『【《]+|["'」』】》]+$/g, '')
      .replace(/[。．.\s]+$/, '')
      .slice(0, 40)
    return title || null
  } catch (error) {
    console.warn('[title] 生成失败：', error instanceof Error ? error.message : error)
    return null
  }
}
