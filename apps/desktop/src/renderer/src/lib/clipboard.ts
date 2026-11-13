/**
 * 复制文本到系统剪贴板。
 * Electron 渲染层在开发地址下 navigator.clipboard 可能不可用（非安全上下文），
 * 兜底走隐藏 textarea + execCommand，保证「复制」按钮不会静默失效。
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 落到下面的兜底路径
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('复制失败')
  } finally {
    textarea.remove()
  }
}
