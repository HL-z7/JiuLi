import fs from 'node:fs'
import os from 'node:os'
import moment from 'moment'
import { JiuLiPlugin, cfg } from 'jiuli'
import { PluginsLoader, renderService } from 'jiuli/core'

/** 真实框架版本（cfg.package 可能被伪装成 trss-yunzai） */
let realVersion
function getRealVersion() {
  if (realVersion) return realVersion
  try {
    realVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  } catch {
    realVersion = '0.0.0'
  }
  return realVersion
}

const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`

/** 耗时：1 秒以内给毫秒，超过给秒（保留两位） */
const ms = n => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`)

/**
 * 系统名
 *
 * `os.release()` 在 Windows 上永远返回 `10.0.<build>`，Win11 从 build 22000 起，
 * 直接拼 os.type() 会把 Win11 显示成 "Windows_NT 10.0.26200"。
 */
function osName() {
  const release = os.release()
  if (process.platform === 'win32') {
    const build = Number(release.split('.')[2])
    const name = build >= 22000 ? 'Windows 11' : build >= 10240 ? 'Windows 10' : 'Windows'
    return build ? `${name} (build ${build})` : `${name} ${release}`
  }
  if (process.platform === 'darwin') return `macOS ${release}`
  if (process.platform === 'linux') {
    try {
      const pretty = /^PRETTY_NAME="?([^"]+)"?$/m.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1]
      if (pretty) return `${pretty} (${release})`
    } catch {}
  }
  return `${os.type()} ${release}`
}

/**
 * #状态 / #统计
 *
 * 默认给主人一屏概要；带参数时查明细：
 *   #状态 用户 10001 · #状态 群 123456 · #状态 日期 20260914 · #状态 消息 image
 */
export default class Status extends JiuLiPlugin {
  constructor() {
    super({
      name: '状态统计',
      dsc: '#状态 #插件速度',
      event: 'message',
      rule: [
        { reg: '^#(状态|统计)', fnc: 'status' },
        { reg: '^#插件(加载|速度|耗时)', fnc: 'pluginSpeed', permission: 'master' },
      ],
    })
  }

  async status() {
    const arg = String(this.e.msg).replace(/^#(状态|统计)/, '').trim()
    /** 非主人或带参数：只给消息统计 */
    if (arg || !this.e.isMaster) {
      const cmd = arg ? this.parseArgs(arg) : { 用户: this.e.user_id, 群: this.e.group_id }
      return this.reply(await this.getCount(cmd))
    }
    return this.reply(await this.summary())
  }

  /** 主人视图：运行时间 / 内存 / 系统 / 收发消息 */
  async summary() {
    const today = moment().format('YYYY:MM:DD')
    const [recv, send, recvAll, sendAll, users, groups] = await Promise.all([
      this.readCount(`receive:msg:total:${today}`),
      this.readCount(`send:msg:total:${today}`),
      this.readCount('receive:msg:total:total'),
      this.readCount('send:msg:total:total'),
      this.keysLength('Yz:count:receive:msg:user:*:total'),
      this.keysLength('Yz:count:receive:msg:group:*:total'),
    ])

    const name =
      cfg.frameworkName === 'JiuLi' ? 'JiuLi' : `JiuLi（对外标识 ${cfg.frameworkName}）`
    const rules = PluginsLoader.priority.reduce((n, i) => n + (i.plugin.rule?.length || 0), 0)

    return [
      `${name} v${getRealVersion()}`,
      `运行时间：${Bot.getTimeDiff()}`,
      `内存使用：${mb(process.memoryUsage().rss)} / 系统 ${mb(os.totalmem())}`,
      `系统版本：${osName()} · ${process.platform} ${process.arch}`,
      `运行环境：Node ${process.version} · ${Bot.uin.length} 个账号在线`,
      `插件：${PluginsLoader.pluginCount} 个 · 规则 ${rules} 条 · 渲染${renderService.renderers.size ? '就绪' : '不可用'}`,
      `用户量：${users} · 群量：${groups}`,
      `消息 今日：收 ${recv} · 发 ${send}`,
      `消息 总计：收 ${recvAll} · 发 ${sendAll}`,
    ].join('\n')
  }

  /**
   * 各插件从开始加载到就绪的耗时（并行导入，含公共依赖解析，仅作参考）
   *
   * 整段文本一次发出：以前每行一个合并转发节点，在 QQ 里要一条条点开看。
   */
  async pluginSpeed() {
    const entries = Object.entries(PluginsLoader.load_time ?? {}).sort((a, b) => b[1] - a[1])
    if (!entries.length) return this.reply('还没有加载耗时数据，重载后再看', true)
    const total = entries.reduce((n, [, t]) => n + t, 0)
    const lines = [
      `插件文件加载耗时：共 ${entries.length} 个，合计 ${ms(total)}`,
      '按就绪耗时倒序；并行导入，数值含公共依赖解析，只作参考',
      ...entries.map(([file, t], i) => `${String(i + 1).padStart(3)}. ${ms(t).padStart(8)}  ${file}`),
    ]
    return this.reply(lines.join('\n'))
  }

  parseArgs(arg) {
    const cmd = {}
    let key = ''
    for (const i of arg.split(' ')) {
      if (key) {
        cmd[key] = i
        key = ''
      } else key = i
    }
    return cmd
  }

  async getCount(cmd) {
    const date = []
    if (cmd['日期']) {
      cmd['日期'] = String(cmd['日期']).replace(/[^\d]/g, '')
      switch (cmd['日期'].length) {
        case 8:
          date.push([cmd['日期'].slice(0, 4), cmd['日期'].slice(4, 6), cmd['日期'].slice(6, 8)])
          break
        case 4:
          date.push([moment().format('YYYY'), cmd['日期'].slice(0, 2), cmd['日期'].slice(2, 4)])
          break
        case 2:
          date.push([moment().format('YYYY'), moment().format('MM'), cmd['日期']])
          break
        default:
          await this.reply(`日期格式错误：${cmd['日期']}`)
          return ''
      }
    } else {
      const d = moment()
      for (let i = 0; i < 3; i++) {
        date.push(d.format('YYYY MM DD').split(' '))
        d.add(-86400000)
      }
      date.push([d.format('YYYY'), d.format('MM')], [d.format('YYYY')], ['total'])
    }

    let msg = '消息统计'
    if (cmd['消息']) msg = `${cmd['消息']} ${msg}`
    else cmd['消息'] = 'msg'

    const array = []
    if (cmd['机器人']) array.push({ text: '机器人', key: 'bot', id: cmd['机器人'] })
    if (cmd['用户']) array.push({ text: '用户', key: 'user', id: cmd['用户'] })
    if (cmd['群']) array.push({ text: '群', key: 'group', id: cmd['群'] })
    if (!array.length) {
      array.push(
        { text: msg, key: 'total' },
        { type: 'keys', text: '用户量', key: 'user:*' },
        { type: 'keys', text: '群量', key: 'group:*' },
      )
      msg = ''
      if (this.e.self_id) array.push({ text: '机器人', key: 'bot', id: this.e.self_id })
      if (this.e.user_id) array.push({ text: '用户', key: 'user', id: this.e.user_id })
      if (this.e.group_id) array.push({ text: '群', key: 'group', id: this.e.group_id })
    }

    for (const i of array) {
      if (i.id) {
        i.text += ` ${i.id}`
        i.key += `:${i.id}`
      }
      msg += `\n\n${i.text}`
      for (let d of date) {
        const key = `:${cmd['消息']}:${i.key}:${d.join(':')}`
        const label = d.join('-')
        const line = label === 'total' ? '总计 -------' : `${label} ${'-'.repeat(Math.max(0, 11 - label.length))}`
        const ret = await this.getRedisCount(i.type, key)
        msg += `\n${line} 收 ${ret.receive} 发 ${ret.send}`
      }
    }
    return msg
  }

  async getRedisCount(type, key) {
    const ret = {}
    for (const i of ['receive', 'send']) {
      const k = `Yz:count:${i}${key}`
      ret[i] = type === 'keys' ? await this.keysLength(k) : Number(await redis.get(k)) || 0
    }
    return ret
  }

  async readCount(key) {
    return Number(await redis.get(`Yz:count:${key}`)) || 0
  }

  async keysLength(match) {
    let cursor = 0
    let length = 0
    do {
      const reply = await redis.scan(cursor, { MATCH: match, COUNT: 10000 })
      cursor = reply.cursor
      length += reply.keys.length
    } while (cursor !== 0)
    return length
  }
}
