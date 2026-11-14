/** 工作流引擎的错误类型（引擎与沙箱通信层共用，避免循环依赖） */

/** 脚本 / 引擎层面的可预期错误（模型看得到消息并能据此修正脚本） */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/** 用户取消或整体超时：必须冒泡终止整次运行，不能被 parallel/pipeline 降级成 null */
export class WorkflowAbortedError extends Error {
  constructor(message = '工作流已取消') {
    super(message)
    this.name = 'WorkflowAbortedError'
  }
}

/** 脚本解析错误（meta 缺失 / 语法 / 禁用构造） */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}
