import { JiuLiPlugin, cfg } from 'jiuli'
import { PluginsLoader } from 'jiuli/core'

const temp = {}

/** 关机状态下的"开机"插件（被 Restart 动态挂载） */
class Start extends JiuLiPlugin {
  constructor(e) {
    super({
      name: '开机',
      dsc: '#开机',
      event: 'message',
      rule: [{ reg: /^#开机$/, fnc: 'start' }],
    })
    if (e) this.e = e
  }

  async start() {
    if (!this.e.isMaster || !temp.priority) return false
    PluginsLoader.priority = temp.priority
    delete temp.priority
    temp.start_time = Date.now()
    return this.reply(`开机成功，距离上次关机${Bot.getTimeDiff(temp.stop_time)}`)
  }
}

/**
 * #重启 / #关机（#停机 是别名）
 *
 * 关机通过把分发列表替换为「只保留开机插件」实现（与云崽一致的技巧），
 * 期间除 #开机 外所有指令都不响应；重启会记录上下文并在下次上线时通知到原会话。
 *
 * 原先的 #停机 是直接退出进程（Bot.exit），在 pm2 托管下会被立刻重新拉起，
 * 看起来就是「停机=重启」，所以这个功能已经删掉，停机改成与关机同义。
 */
export default class Restart extends JiuLiPlugin {
  constructor(e) {
    super({
      name: '进程管理',
      dsc: '#重启 #关机 #停机',
      event: 'message',
      priority: -Infinity,
      rule: [
        { reg: '^#重启$', fnc: 'restart', permission: 'master' },
        { reg: '^#?(关机|停机)$', fnc: 'stop', permission: 'master' },
      ],
    })
    if (e) this.e = e
  }
  key = 'Yz:restart'

  init() {
    Bot.once('online', this.restartMsg.bind(this))
    this.e = {
      reply: msg => Bot.sendMasterMsg(msg),
      isMaster: true,
    }
    if (cfg.bot.restart_time) setTimeout(this.restart.bind(this), cfg.bot.restart_time * 60000)

    this.task = []
    const push = (name, cron, fnc) => {
      for (const i of Array.isArray(cron) ? cron : [cron]) this.task.push({ name, cron: i, fnc })
    }
    if (cfg.bot.restart_cron) push('定时重启', cfg.bot.restart_cron, this.restart.bind(this))
    if (cfg.bot.stop_cron) push('定时关机', cfg.bot.stop_cron, this.stop.bind(this))
    if (cfg.bot.start_cron) push('定时开机', cfg.bot.start_cron, () => new Start(this.e).start())
  }

  async restartMsg() {
    const raw = await redis.get(this.key)
    if (!raw) return
    /** 原子认领：多个监听器同时在（重复实例化、热重载残留）时只有删掉键的那个发通知 */
    if (!(await redis.del(this.key))) return
    const restart = JSON.parse(raw)
    if (restart.isStop) return this.stop(restart.time)

    const time = Bot.getTimeDiff(restart.time)
    /** isExit 只可能来自旧版本 #停机 留下的键，现已没有这个指令 */
    const msg = [restart.isExit ? `开机成功，距离上次停止${time}` : `重启成功，用时${time}`]

    if (restart.group_id) await Bot.sendGroupMsg(restart.bot_id, restart.group_id, msg)
    else if (restart.user_id) await Bot.sendFriendMsg(restart.bot_id, restart.user_id, msg)
    else await Bot.sendMasterMsg(msg)
  }

  /** 重启前记录上下文；重启上线后由 restartMsg 通知到原会话 */
  async set() {
    if (temp.priority)
      return redis.set(this.key, JSON.stringify({ isStop: true, time: temp.stop_time }))
    await this.reply(`开始重启，本次运行时长${Bot.getTimeDiff()}`)
    return redis.set(
      this.key,
      JSON.stringify({
        isExit: false,
        group_id: this.e.group_id,
        user_id: this.e.user_id,
        bot_id: this.e.self_id,
        time: Date.now(),
      }),
    )
  }

  async restart() {
    await this.set()
    const ret = await Bot.restart()
    await this.reply(`重启错误\n${Bot.String(ret)}`)
  }

  async stop(time) {
    if (temp.priority) return false
    temp.priority = PluginsLoader.priority
    PluginsLoader.priority = [{ plugin: new Start(), class: Start, key: 'system/restart-start', name: '开机', priority: 0, namespace: 'system/restart-start' }]
    if (typeof time === 'number') return (temp.stop_time = time)
    temp.stop_time = Date.now()
    return this.reply(`关机成功，本次运行时长${Bot.getTimeDiff(temp.start_time)}\n发送 #开机 即可恢复响应`)
  }
}

export { Start, Restart }
