import EventListener from '../listener/listener.js'

export default class onlineEvent extends EventListener {
  constructor() {
    super({
      event: 'online',
      once: true,
    })
  }

  async execute() {
    // getTimeDiff 仅新版内核提供，旧核心下省略耗时
    const cost = typeof Bot?.getTimeDiff === 'function' ? Bot.getTimeDiff() : ''
    const msg = `──────── 启动完成${cost ? ` · 总耗时 ${cost}` : ''} ────────`
    if (typeof Bot?.makeLog === 'function') Bot.makeLog('mark', msg, 'JiuLi')
    else logger.mark(msg)
  }
}
