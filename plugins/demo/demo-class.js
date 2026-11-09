import { JiuLiPlugin } from 'jiuli'

/**
 * JiuLi 原生插件示例（类形态）
 *
 * 与旧插件写法的区别：
 * - 继承 JiuLiPlugin（而不是全局 plugin），有完整类型提示
 * - 可用 this.render(tpl, data) 渲染图片
 * - 可用 this.dataDir 获取插件私有数据目录
 */
export default class ExampleClass extends JiuLiPlugin {
  constructor() {
    super({
      name: 'JiuLi示例(类)',
      dsc: '原生类形态插件示例',
      event: 'message',
      priority: 100,
      rule: [
        { reg: '^#例子你好$', fnc: 'hello' },
        { reg: '^#例子渲染$', fnc: 'renderDemo' },
      ],
      task: [{ cron: '0 3 * * *', fnc: 'daily', name: '示例定时' }],
    })
  }

  async hello(e) {
    await this.reply(`你好呀，${e.sender?.nickname || e.user_id}，这里是 JiuLi 原生类形态插件`)
    return true
  }

  async renderDemo() {
    const img = await this.render('hello/index', {
      title: 'JiuLi 渲染测试',
      time: new Date().toLocaleString(),
    })
    if (!img) return this.reply('渲染失败（puppeteer 不可用）')
    return this.reply(img)
  }

  async daily() {
    const files = await import('node:fs/promises')
    await files.writeFile(`${this.dataDir}/last-daily.txt`, new Date().toISOString())
    Bot.makeLog('mark', '[JiuLi示例] 每日任务已执行', 'Demo')
  }
}
