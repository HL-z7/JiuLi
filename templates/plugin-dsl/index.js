/**
 * {{name}} 插件（函数式 DSL）
 *
 * 生成的骨架，改完保存后重启即可生效。
 * 完整文档：docs/plugin-guide.md
 */
import { definePlugin, command, task, accept } from 'jiuli'

export default definePlugin({
  /** 插件名（#插件列表 与群配置的 enable/disable 用这个名字） */
  name: '{{name}}',
  dsc: '插件描述',
  priority: 5000,

  apps: [
    /** 命令：正则 → 处理函数（第二个参数是正则匹配结果） */
    command(
      /^#示例$/,
      async e => {
        await e.reply(`你好，${e.sender?.nickname || e.user_id}`)
        return true // false 表示继续匹配后面的规则
      },
      { name: '示例' },
    ),

    /** 带捕获组 */
    command(/^#示例\s+(.+)$/, async (e, match) => {
      await e.reply(`你输入的是：${match?.[1]}`)
    }),

    /** 仅主人可用 */
    command(/^#示例管理$/, async e => {
      await e.reply('管理员指令')
    }, { permission: 'master' }),

    /** 定时任务（没有 e，需要发消息用 Bot.sendMasterMsg / Bot.sendGroupMsg） */
    task('0 8 * * *', () => logger.mark('[{{name}}] 早安任务执行'), { name: '早安' }),

    /** 通知 / 请求事件 */
    // accept('notice.group.poke', async e => e.reply('别戳了')),

    /** 跨插件调用：其他插件用 e.runtime.handler.call('{{name}}.echo', e, '参数') 调用 */
    // handler('{{name}}.echo', (e, args) => `echo: ${args}`),
  ],
})
