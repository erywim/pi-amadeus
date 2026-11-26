/**
 * 模型能力判定：与「选哪个模型」解耦，供调度器与执行层共用。
 * 自定义模型无从查询能力清单，只能按 OpenAI 兼容生态的模型 id 特征保守匹配；
 * 未知按纯文本处理（纯文本模型收到 image 块会直接报 400，宁缺毋滥）。
 */
export function supportsVision(modelId: string): boolean {
  const m = modelId.toLowerCase()
  return (
    m.includes('vision') ||
    m.includes('-vl') ||
    m.includes('vl-') ||
    /gpt-4o|gpt-5|claude|gemini|minicpm|internvl|qwen2?[._]?vl|glm-4v|step-1o/.test(m) ||
    m.startsWith('o4-') ||
    m.startsWith('o3')
  )
}
