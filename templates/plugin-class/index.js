/**
 * {{name}} 插件（类形态）
 *
 * 生成的骨架，改完保存后重启即可生效。
 * 完整文档：docs/plugin-guide.md
 */
import { JiuLiPlugin } from 'jiuli'

export default class {{ClassName}} extends JiuLiPlugin {
  constructor() {
    super({
      /** 插件名（#插件列表 与群配置的 enable/disable 用这个名字） */
      name: '{{name}}',
      /** 描述 */
      dsc: '插件描述',
      /**
       * 监听的事件（与云崽一致）
       *   message                    所有消息
       *   message.group              仅群聊
       *   message.private            仅私聊
       *   notice.group.poke          群戳一戳
       *   request.friend             好友请求
       */
      event: 'message',
      /** 优先级：数字越小越先执行，默认 5000 */
      priority: 5000,
      /**
       * 命令规则：
       *   reg        正则（字符串或 /正则/），匹配 e.msg
       *   fnc        本类中的方法名
       *   permission 可选：master（仅主人）/ owner（群主）/ admin（管理员）
       *   log: false 不打印"开始处理/完成"日志
       */
      rule: [
        { reg: '^#示例$', fnc: 'demo' },
        { reg: /^#示例\s+(.+)$/, fnc: 'demoArgs' },
        // { reg: '^#管理$', fnc: 'admin', permission: 'master' },
      ],
      /**
       * 定时任务（可选）：cron 为 5/6 段表达式，fnc 是方法名或函数
       * 注意：定时任务里 this.e 是空的，不要调用 this.reply
       */
      // task: [{ name: '每日任务', cron: '0 8 * * *', fnc: 'daily' }],
    })
  }

  /**
   * @param {import('jiuli').JiuLiEvent} e 事件对象
   */
  async demo(e) {
    // 发送文本；第二个参数为 true 时引用回复
    await e.reply(`你好，${e.sender?.nickname || e.user_id}`)

    // 常用写法：
    // await e.reply([segment.at(e.user_id), '\n并 at 你'])
    // await e.reply('5 秒后撤回', true, { recallMsg: 5 })
    // await e.group.sendMsg('主动发群消息')
    // const img = await this.render('示例/index', { title: '标题' })  // 模板放 resources/示例/index.html（平铺插件即 plugins/example/resources/）
    // await e.reply(img || '渲染失败')

    return true // 返回 false 表示继续匹配后面的规则
  }

  /** 带正则捕获组：匹配结果从第二个参数取 */
  async demoArgs(e, match) {
    await e.reply(`你输入的是：${match?.[1]}`)
  }

  /** 需要等待用户下一条消息时使用上下文会话 */
  // async ask(e) {
  //   this.setContext('waiting')          // 开启会话（默认 120 秒超时）
  //   return this.reply('请发送内容')
  // }
  // async waiting() {                     // 方法名与 setContext 的 type 一致
  //   this.finish('waiting')              // 结束会话
  //   return this.reply(`收到：${this.e.msg}`)
  // }

  /** 定时任务示例（没有 this.e） */
  // async daily() {
  //   logger.mark('[{{name}}] 每日任务执行')
  //   await Bot.sendMasterMsg('每日任务完成')
  // }
}
