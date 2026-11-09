import { JiuLiPlugin } from 'jiuli'
import { Restart } from './restart.js'

/** 同一时间只允许一个安装流程 */
let installing = false

/** 常用插件源；#安装插件 不带参数时列出其中尚未安装的 */
const list = {
  Atlas: 'https://gitee.com/Nwflower/atlas',
  genshin: 'https://git.trss.me/Yunzai-genshin',
  'DF-Plugin': 'https://gitee.com/DenFengLai/DF-Plugin',
  'ws-plugin': 'https://gitee.com/xiaoye12123/ws-plugin',
  'TRSS-Plugin': 'https://git.trss.me/TRSS-Plugin',
  'miao-plugin': 'https://gitcode.com/TimeRainStarSky/miao-plugin.git',
  'Philia-Plugin': 'https://org.trss.me/Yunzai-Philia-Plugin',
  'Guoba-Plugin': 'https://gitee.com/guoba-yunzai/guoba-plugin',
  'yenai-plugin': 'https://gitee.com/yeyang52/yenai-plugin',
  'flower-plugin': 'https://gitee.com/Nwflower/flower-plugin',
  'xianyu-plugin': 'https://gitee.com/suancaixianyu/xianyu-plugin',
  'earth-k-plugin': 'https://gitee.com/SmallK111407/earth-k-plugin',
  'useless-plugin': 'https://gitee.com/SmallK111407/useless-plugin',
  'StarRail-plugin': 'https://gitee.com/hewang1an/StarRail-plugin',
  'xiaoyao-cvs-plugin': 'https://gitcode.com/TimeRainStarSky/xiaoyao-cvs-plugin.git',
  'trss-xianxin-plugin': 'https://gitee.com/snowtafir/xianxin-plugin',
  'Telegram-Plugin': 'https://git.trss.me/Yunzai-Telegram-Plugin',
  'Discord-Plugin': 'https://git.trss.me/Yunzai-Discord-Plugin',
  'WeChat-Plugin': 'https://git.trss.me/Yunzai-WeChat-Plugin',
  'QQBot-Plugin': 'https://git.trss.me/Yunzai-QQBot-Plugin',
  'Route-Plugin': 'https://git.trss.me/Yunzai-Route-Plugin',
  'ICQQ-Plugin': 'https://git.trss.me/Yunzai-ICQQ-Plugin',
  'KOOK-Plugin': 'https://git.trss.me/Yunzai-KOOK-Plugin',
  'Secluded-Plugin': 'https://github.com/Lovely02Y/Secluded-Adapter',
}

/** 去掉 -Plugin 后缀的短名 → 全名，`#安装ICQQ` 也能命中 `ICQQ-Plugin` */
const short = {}
for (const i in list) short[i.replace(/-[Pp]lugin$/, '')] = i

/**
 * #安装插件 [名字|git 地址]
 *
 * 名单见上面的 list；给 git 地址则直接克隆，目录名取仓库名。
 * 装完自动 pnpm install（工作区包含 plugins/**）并重启。
 */
export default class Install extends JiuLiPlugin {
  constructor(e) {
    super({
      name: '安装插件',
      dsc: '#安装插件 #安装ICQQ #安装插件 <git 地址>',
      event: 'message',
      priority: -Infinity,
      rule: [{ reg: /^#安装(插件)?\s*(.*)$/, fnc: 'install', permission: 'master' }],
    })
    if (e) this.e = e
  }

  /** 在插件目录（或仓库根）执行命令 */
  exec(cmd, plugin = '', opts = {}) {
    return Bot.exec(cmd, { quiet: true, cwd: plugin ? `plugins/${plugin}` : process.cwd(), ...opts })
  }

  /** git 地址 → 目录名 */
  dirName(url) {
    return (
      String(url)
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop()
        .replace(/\.git$/, '') || ''
    )
  }

  async list() {
    const msg = []
    for (const i in list) if (!(await Bot.fsStat(`plugins/${i}`))) msg.push(i)
    if (!msg.length) return this.reply('名单里的插件都已安装\n也可以 #安装插件 <git 地址>')
    return this.reply(`可安装插件：\n${msg.join('\n')}\n\n发送 #安装+插件名，或 #安装插件 <git 地址>`)
  }

  async install() {
    if (!this.e?.isMaster) return false
    if (installing) return this.reply('正在安装，请稍候再试')

    const key = String(this.e.msg || '')
      .replace(/^#安装/, '')
      .replace(/^插件\s*/, '')
      .trim()
    if (!key) return this.list()

    /** 直接给地址时按地址装，否则查名单 */
    const fromUrl = /^(https?:\/\/|git@)/.test(key) || key.endsWith('.git')
    const url = fromUrl ? key : list[short[key] || key]
    if (!url)
      return this.reply(`没有「${key}」这个插件\n发送 #安装插件 看可安装列表，或 #安装插件 <git 地址>`)

    const name = fromUrl ? this.dirName(url) : short[key] || key
    const dir = `plugins/${name}`
    if (await Bot.fsStat(dir)) return this.reply(`「${name}」已存在，发送 #更新${name} 可更新`)

    installing = true
    try {
      await this.reply(`开始安装「${name}」\n${url}`)
      Bot.makeLog('mark', `开始安装 ${name} · ${url}`, 'Install')

      const ret = await this.exec(`git clone --depth 1 --single-branch "${url}" "${dir}"`)
      if (ret.error) {
        Bot.makeLog('mark', `${name} 安装失败`, 'Install')
        return this.gitErr(name, ret.error.message, ret.stdout)
      }

      if (await Bot.fsStat(`${dir}/package.json`)) {
        await this.reply('正在安装依赖')
        const pkg = await this.exec('pnpm install')
        if (pkg.error)
          return this.reply(`依赖安装失败，请手动执行 pnpm install\n${Bot.String(pkg.stderr || pkg.error)}`)
      }

      await this.reply(`「${name}」安装完成，即将重启加载`)
      return this.restart()
    } finally {
      installing = false
    }
  }

  /** git 报错里那句被引号包起来的地址 */
  gitErrUrl(error = '') {
    return error.match(/'(.+?)'/g)?.[0]?.replace(/'/g, '') || ''
  }

  async gitErr(name, error, stdout) {
    if (/unable to access|无法访问|Could not resolve|Failed to connect/i.test(error))
      await this.reply(`远程仓库连接失败：${this.gitErrUrl(error) || error}\n请检查网络或代理后重试`)
    else if (/not found|未找到|does not (exist|appear)|不存在|Authentication failed|鉴权失败/i.test(error))
      await this.reply(`远程仓库地址或凭据有误：${this.gitErrUrl(error) || error}`)
    else await this.reply(`「${name}」安装失败\n${error}\n${stdout || ''}`)
    return false
  }

  restart() {
    return new Restart(this.e).restart()
  }
}

/** 兼容旧插件的具名导入：import { install } from '../../other/install.js' */
export { Install as install }
