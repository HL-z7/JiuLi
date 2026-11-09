import { definePlugin, command, task, logger, metrics } from 'jiuli'

/**
 * JiuLi 原生插件示例（函数式 DSL）
 *
 * command / task / accept / handler 返回描述对象，
 * definePlugin 把它们组装成内核可加载的插件。
 */
export default definePlugin({
  name: 'JiuLi示例(DSL)',
  dsc: '原生函数式 DSL 插件示例',
  priority: 100,
  apps: [
    command(
      /^#?(玖璃|jiuli)你好$/,
      async (e, match) => {
        await e.reply(`你好，这里是 JiuLi 原生 DSL 插件${match?.[1] ? `（捕获组：${match[1]}）` : ''}`)
        return true
      },
      { name: '打招呼' },
    ),

    command(
      /^#玖璃性能$/,
      async e => {
        await e.reply(metrics.summary())
        return true
      },
      { permission: 'master', name: '性能统计' },
    ),

    task('0 8 * * *', () => Bot.makeLog('mark', '[JiuLi示例] 早安任务执行', 'Demo'), { name: '早安' }),
  ],
})
