/**
 * bash 工具安全策略：高危操作黑名单（保守、零误伤）。
 * 三层防护的第一道（beforeToolCall 钩子）与第三道（execute 入口二次校验）
 * 共用同一判定；被拦截的命令不会执行、不会弹确认卡。
 */

/** 拦截原因的固定前缀（LLM 可见 + 渲染端据此识别 deniedReason='blocked'） */
export const BLOCK_PREFIX = '该命令被安全策略禁止：'

interface SafetyRule {
  /** 正则（小写化后匹配） */
  pattern: RegExp
  reason: string
}

const RULES: SafetyRule[] = [
  // ---- 磁盘/文件毁灭 ----
  { pattern: /(^|[\s;&|])format(\s|$)/, reason: '磁盘格式化命令被禁止' },
  { pattern: /\bmkfs(\s|\.|$)/, reason: '文件系统创建（mkfs）命令被禁止' },
  { pattern: /\bdiskpart\b/, reason: '磁盘分区管理（diskpart）被禁止' },
  { pattern: /\bfdisk\b/, reason: '磁盘分区管理（fdisk）被禁止' },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: '直接写入磁盘设备的 dd 命令被禁止' },
  { pattern: /\bshred\b/, reason: '文件销毁（shred）命令被禁止' },
  {
    pattern: /(^|[\s;&|])rm\s+(-\w+\s+)*(-\w*r[fw]*\w*\s+)*(\/|~|\/\*|~\/*|"\/"|%windir%|c:\\windows|c:\\)/i,
    reason: '递归删除系统根目录/家目录被禁止'
  },
  {
    pattern: /(^|[\s;&|])(rd|rmdir)\s+(\/s\s+\/q|\/q\s+\/s)\s+[a-z]:\\/i,
    reason: '删除整个磁盘目录被禁止'
  },
  {
    pattern: /(^|[\s;&|])del\s+(\/[a-z]\s+)*[a-z]:\\/i,
    reason: '删除磁盘根目录内容被禁止'
  },
  {
    pattern: /remove-item\s+.*-(recurse|r)\b.*[a-z]:\\/i,
    reason: '递归删除磁盘目录（Remove-Item）被禁止'
  },
  // ---- 关机/重启/注销 ----
  { pattern: /(^|[\s;&|])(shutdown|reboot|halt|poweroff)(\s|$)/, reason: '关机/重启命令被禁止' },
  { pattern: /(restart|stop)-computer/i, reason: '关机/重启命令被禁止' },
  { pattern: /(^|[\s;&|])logoff(\s|$)/i, reason: '注销会话命令被禁止' },
  // ---- 远程执行管道（提示注入 → 任意代码执行链） ----
  { pattern: /(curl|wget|fetch|iwr|invoke-webrequest)[^|;&<>]*\|\s*(ba)?sh\b/i, reason: '下载内容直通 shell 执行的管道被禁止' },
  { pattern: /(curl|wget)[^|;&<>]*\|\s*(sudo\s+)?(bash|zsh|sh|python|perl|ruby|node)\b/i, reason: '下载内容直通解释器执行的管道被禁止' },
  { pattern: /bash\s*<\s*\(\s*curl/i, reason: '进程替换远程执行（bash <(curl)）被禁止' },
  { pattern: /iex\s*[(\s]*\(?\s*iwr/i, reason: 'PowerShell 下载执行（iex iwr）被禁止' },
  { pattern: /invoke-expression\b/i, reason: 'Invoke-Expression 动态执行被禁止' },
  { pattern: /powershell.*-(enc|encodedcommand)/i, reason: '编码混淆命令（-EncodedCommand）被禁止' },
  { pattern: /\bmshta\s+https?:/i, reason: 'mshta 远程脚本加载被禁止' },
  { pattern: /certutil\s+-urlcache/i, reason: 'certutil 下载执行被禁止' },
  { pattern: /(^|[\s;&|])nc(\s|\.exe|$).*-(e|l)\b/i, reason: 'netcat 反弹 shell 被禁止' },
  // ---- 资源耗尽 ----
  { pattern: /:\s*\(\s*\)\s*\{/, reason: 'fork bomb 被禁止' },
  { pattern: /%0\s*\|\s*%0/, reason: 'fork bomb 被禁止' },
  // ---- 系统级注册表 ----
  { pattern: /reg\s+delete\s+hklm/i, reason: '删除 HKLM 注册表项被禁止' },
  { pattern: /reg\s+add\s+hklm\\software\\microsoft\\windows\\currentversion\\(run|winlogon)/i, reason: '写入系统自启动注册表被禁止' }
]

export type SafetyCheck = { allowed: true } | { allowed: false; reason: string }

/** 高危命令判定（大小写不敏感；对 cmd 与 posix shell 命令做保守匹配） */
export function checkBashSafety(command: string): SafetyCheck {
  const lower = command.toLowerCase()
  for (const rule of RULES) {
    if (rule.pattern.test(lower)) {
      return { allowed: false, reason: rule.reason }
    }
  }
  return { allowed: true }
}

/** beforeToolCall 拦截用的 LLM 可见 reason 文本 */
export function blockReason(reason: string): string {
  return `${BLOCK_PREFIX}${reason}`
}
