import { JiuLiPlugin } from 'jiuli'
import { PluginsLoader } from 'jiuli/core'

/**
 * #玖璃帮助 / #插件列表
 * 内置指令说明 + 已加载插件与指令一览（转发消息）
 */
export default class Help extends JiuLiPlugin {
  constructor() {
    super({
      name: '帮助',
      dsc: '#玖璃帮助',
      event: 'message',
      /**
       * 普通优先级：用户的帮助/菜单插件能抢在它前面接手 #帮助。
       * 刻意不用默认值 5000，避免和「没写 priority 的插件」同档、位次由加载顺序决定。
       */
      priority: 4000,
      rule: [
        { reg: '^#(玖璃|JiuLi|jiuli)(帮助|菜单)$', fnc: 'help' },
        { reg: '^#帮助$', fnc: 'help' },
        { reg: '^#(插件列表|功能列表|指令列表)$', fnc: 'pluginList' },
      ],
    })
  }

  async help() {
    const text = [
      'JiuLi 指令说明',
      '【#玖璃帮助】本说明（#帮助 可能被你的菜单插件接管）',
      '【#插件列表】查看已加载插件与指令',
      '【#状态】运行状态与消息统计',
      '【#诊断】排查"机器人为什么没响应"（适配器/在线账号/最近收发）',
      '【#设置主人】设置主人账号',
      '【#日志】查看最近运行日志（#错误日志 / #日志500）',
      '【#重启】【#关机 / #停机】进程管理（关机后除 #开机 外不响应指令）',
      '【#更新】拉取框架更新',
      '【#撤回】撤回触发消息与机器人回复',
      '【#添加】【#删除】【#消息列表】词条管理',
      '【#渲染测试】【#渲染列表】【#渲染图片】【#渲染长图】渲染功能自检',
    ].join('\n')
    const tip = [
      '使用提示',
      '· 终端直接输入指令即可（标准输入适配器），或连接协议端后正常聊天触发',
      '· 群聊默认需要 at 机器人或使用前缀（config/config/group.yaml → botAlias / onlyReplyAt）',
      '· 日志会记录「谁说了什么」与「机器人回了什么」，见 config/config/bot.yaml → log_msg',
      '· 插件与适配器放在 plugins/ 目录，支持热重载（平铺 js 文件）',
    ].join('\n')
    return this.reply(Bot.makeForwardArray([text, tip]))
  }

  async pluginList() {
    const lines = []
    for (const i of PluginsLoader.priority) {
      const rules = (i.plugin.rule || []).map(r => `  ${r.reg}`).filter(Boolean)
      lines.push(`${i.name}（${i.key}）${rules.length ? `\n${rules.join('\n')}` : '  [事件监听]'}`)
    }
    const chunks = []
    let current = '已加载插件与指令'
    for (const line of lines) {
      if (current.length + line.length > 1200) {
        chunks.push(current)
        current = ''
      }
      current += `\n${line}`
    }
    if (current) chunks.push(current)
    return this.reply(Bot.makeForwardArray(chunks))
  }
}
