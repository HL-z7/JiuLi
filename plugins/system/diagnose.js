import { JiuLiPlugin, cfg } from 'jiuli'
import { PluginsLoader, MemoryRedis, renderService, metrics, SYSTEM_DEPS, depPath } from 'jiuli/core'
import moment from 'moment'

/**
 * #诊断
 * 一条指令排查"机器人为什么没反应"：适配器/在线账号/插件/渲染/最近收发消息
 */
export default class Diagnose extends JiuLiPlugin {
  constructor() {
    super({
      name: '诊断',
      dsc: '#诊断',
      event: 'message',
      priority: -Infinity,
      rule: [{ reg: '^#诊断$', fnc: 'diagnose', permission: 'master' }],
    })
  }

  async diagnose() {
    const redis = globalThis.redis
    const lines = []

    /** 运行环境 */
    let realVersion = '?'
    try {
      realVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
    } catch {}
    const compat = cfg.package.name === 'trss-yunzai' ? `（兼容 TRSS-Yunzai v${cfg.package.version}）` : ''
    lines.push(
      `【运行】JiuLi v${realVersion}${compat}`,
      `运行时长 ${Bot.getTimeDiff()} · 内存 ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB · Node ${process.version} ${process.platform}/${process.arch}`,
    )

    /** 存储 */
    const redisType = redis instanceof MemoryRedis ? '内存降级（redis_fallback）' : '真实 Redis'
    lines.push(`【存储】${redisType}${redis?.isOpen === false ? ' · 已断开' : ''}`)

    /** 适配器与在线账号 */
    const adapters = Bot.adapter.map(a => `${a.name}(${a.id})`).join(' · ') || '无'
    lines.push(`【适配器】${adapters}`)
    const bots = [...Bot.uin].map(id => {
      const bot = Bot.bots[id]
      return bot ? `${bot.nickname || ''}(${id})` : String(id)
    })
    lines.push(`【在线账号】${bots.length ? bots.join(' · ') : '无（协议端未连接）'}`)

    /** 插件 */
    const rules = PluginsLoader.priority.reduce((n, i) => n + (i.plugin.rule?.length || 0), 0)
    lines.push(`【插件】${PluginsLoader.priority.length} 个 · 规则 ${rules} 条 · 定时任务 ${PluginsLoader.task.length} 个`)

    /** 渲染 */
    const puppeteer = renderService.getRenderer('puppeteer')
    const renderState =
      renderService.renderers.size === 0
        ? '无可用后端'
        : [...renderService.renderers.keys()].join(', ') + (puppeteer?.browser ? ' · Chromium 运行中' : ' · Chromium 未启动（首次截图时启动）')
    lines.push(`【渲染】${renderState}`)

    /** 外部命令（插件常依赖，缺了只在插件运行时报 Command failed） */
    const bins = []
    for (const dep of SYSTEM_DEPS) bins.push(`${dep.cmd} ${(await depPath(dep)) ? '✓' : '✗（缺了会影响：' + dep.desc + '）'}`)
    lines.push(`【系统命令】${bins.join(' · ')}`)

    /** 主人 */
    const masters = Object.entries(cfg.master || {})
      .map(([botId, list]) => `${botId}:${(Array.isArray(list) ? list : []).join(',')}`)
      .join(' · ')
    lines.push(`【主人】${masters || '未配置（发送 #设置主人 设置）'}`)

    /** 消息日志开关 */
    lines.push(`【日志】等级 ${logger.getLevel()} · 消息内容记录 ${cfg.bot.log_msg === false ? '关闭' : '开启'}（config/config/bot.yaml）`)

    /** 最近收发（只留最近 5 条，太多会把聊天顶掉） */
    const RECENT_MAX = 5
    const fmt = i => `${moment(i.time).format('HH:mm:ss')} ${i.scene} · ${i.content}${i.matched ? ` → ${i.matched}` : ''}`
    const recent = PluginsLoader.recent
    const tail = list => list.slice(-RECENT_MAX)
    lines.push(`【最近收到】${recent.receive.length ? `\n${tail(recent.receive).map(fmt).join('\n')}` : '无'}`)
    lines.push(
      `【最近发出】${
        recent.send.length
          ? `\n${tail(recent.send)
              .map(i => `${moment(i.time).format('HH:mm:ss')} ${i.scene} · ${i.content}${i.plugin ? ` · 由 ${i.plugin}` : ''}`)
              .join('\n')}`
          : '无'
      }`,
    )

    /** 慢插件提示 */
    const slow = metrics.list().filter(i => i.total / i.count > 500).slice(0, 3)
    if (slow.length)
      lines.push(`【偏慢插件】${slow.map(i => `${i.name} 均 ${(i.total / i.count).toFixed(0)}ms`).join(' · ')}`)

    /** 十几行直接发会刷屏，走合并转发；每条一行，方便在转发里逐条看 */
    return this.reply(Bot.makeForwardArray([`JiuLi 诊断报告 · ${moment().format('YYYY-MM-DD HH:mm:ss')}`, ...lines]))
  }
}
