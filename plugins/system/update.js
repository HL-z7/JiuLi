import fs from 'node:fs/promises'
import path from 'node:path'
import { JiuLiPlugin, cfg } from 'jiuli'
import { Restart } from './restart.js'

/** 同一时间只允许一个更新流程 */
let updating = false

/**
 * 更新框架本体与插件
 *
 *   #更新 [#安静] [强制] [插件名]
 *   #全部[安静][强制]更新
 *   #更新日志 [插件名]
 *
 * 生态插件会 `new Update(e)` 后直接调用 getPlugin / runUpdate / getLog / restart，
 * 这些方法名与云崽保持一致，不要改。
 */
export default class Update extends JiuLiPlugin {
  constructor(e) {
    super({
      name: '更新',
      dsc: '#更新 #静更新 #强制更新 #全部更新 #更新日志',
      event: 'message',
      priority: -Infinity,
      rule: [
        { reg: '^#更新日志\\s*(.*)$', fnc: 'updateLog' },
        { reg: '^#全部(安?静)?(强制)?更新$', fnc: 'updateAll', permission: 'master', log: false },
        { reg: '^#重启更新$', fnc: 'update', permission: 'master', log: false },
        /**
         * 这里刻意不写 permission：规则 `^#更新` 会命中 `#更新抽卡记录` 这类插件指令，
         * 权限校验失败时 loader 会回一句"没有权限哦"并终止分发，插件就再也接不到了。
         * 与云崽一致：交给 update() 内部 `if (!this.e?.isMaster) return false` 安静让位。
         */
        { reg: '^#(安?静)?(强制)?更新\\s*(.*)$', fnc: 'update' },
      ],
    })
    if (e) this.e = e
  }

  /** 静默模式：只说结果，不说"开始更新"与"已是最新" */
  get quiet() {
    return /^#(全部)?(安?静)/.test(this.e?.msg || '')
  }

  /** 展示名：框架本体为 typeName，插件为目录名 */
  typeName = 'JiuLi'
  isUp = false
  isPkgUp = false
  oldCommitId = ''

  init() {
    /** 自动/定时更新走虚拟事件（与进程管理插件同一套做法） */
    this.e = {
      isMaster: true,
      logFnc: '[自动更新]',
      msg: '#全部静更新',
      reply: msg => Bot.sendMasterMsg(msg),
    }
    if (cfg.bot.update_time) this.autoUpdate()
    this.task = []
    const push = (name, cron, fnc) => {
      for (const i of Array.isArray(cron) ? cron : [cron]) this.task.push({ name, cron: i, fnc })
    }
    if (cfg.bot.update_cron) push('定时更新', cfg.bot.update_cron, () => this.updateAll())
  }

  autoUpdate() {
    setTimeout(() => this.updateAll().finally(() => this.autoUpdate()), cfg.bot.update_time * 60000)
  }

  /** 在插件目录（或仓库根）执行命令 */
  exec(cmd, plugin = '', opts = {}) {
    const cwd = plugin ? path.join(process.cwd(), 'plugins', plugin) : process.cwd()
    return Bot.exec(cmd, { quiet: true, cwd, ...opts })
  }

  /**
   * 把名字解析成 plugins/ 下的目录名；空串表示框架本体，false 表示没找到
   *
   * 宽松匹配：`#更新ICQQ` 能命中 `Yunzai-ICQQ-Plugin`，`#更新qqbot` 会列出所有含 qqbot 的候选
   *
   * 两种情况分开处理：
   * - **匹配到多个**：直接回复候选列表（用户要的就是"有哪些插件"），更新本身不执行；
   *   仍然返回 false —— 后面的插件照常能拿到这条指令，本体不抢。
   * - **一个都没匹配**：不回复，只把提示挂到 `e.__pluginHint`（由框架在所有插件都没接手时补发）。
   *   规则 `^#更新` 天然会命中 `#更新抽卡记录` 这类插件指令（逍遥、miao…），
   *   本体一旦应答就等于把插件指令截胡了。
   */
  async getPlugin(name) {
    const plugin = String(
      name ?? this.e?.msg?.replace(/#(全部)?(安?静)?(强制)?更新(日志)?/, '') ?? '',
    ).trim()
    if (!plugin) {
      this.typeName = 'JiuLi'
      return ''
    }

    const dirs = await fs.readdir('plugins').catch(() => [])
    for (const i of [plugin, `${plugin}-Plugin`, `${plugin}-plugin`])
      if (dirs.includes(i)) return (this.typeName = i)

    const key = plugin.toLowerCase()
    const hits = dirs.filter(i => {
      const low = i.toLowerCase()
      return low.endsWith(`${key}-plugin`) || low.endsWith(key) || low.includes(key)
    })
    if (hits.length === 1) return (this.typeName = hits[0])
    if (hits.length > 1) {
      /** 多个候选：直接回答"有哪些插件"（更新不执行），但仍返回 false 让后面的插件照常接手 */
      await this.reply(`「${plugin}」匹配到多个插件：\n${hits.join(' · ')}\n请写明完整目录名`)
      return false
    }
    this.e.__pluginHint = `plugins/ 下没有「${plugin}」，可用 #插件列表 查看`
    return false
  }

  async getCommitId(plugin = '') {
    return (await this.exec('git rev-parse --short HEAD', plugin)).stdout
  }

  async getTime(plugin = '') {
    return (await this.exec('git log -1 --pretty=%cd --date=format:"%F %T"', plugin)).stdout
  }

  async getBranch(plugin = '') {
    return (await this.exec('git branch --show-current', plugin)).stdout
  }

  async getRemote(branch, plugin = '') {
    return (await this.exec(`git config branch.${branch}.remote`, plugin)).stdout
  }

  /** string 为真时返回 `origin/master` 这种字符串，否则返回 { remote, branch } */
  async getRemoteBranch(str, plugin = '') {
    const branch = await this.getBranch(plugin)
    if (!branch && str) return ''
    const remote = await this.getRemote(branch, plugin)
    if (!remote && str) return ''
    return str ? `${remote}/${branch}` : { remote, branch }
  }

  async getRemoteUrl(branch, hide, plugin = '') {
    if (branch) {
      const url = (await this.exec(`git config remote.${branch}.url`, plugin)).stdout
      return hide ? url.replace(/\/\/([^@]+)@/, '//') : url
    }
    const ret = await this.exec('git config -l', plugin)
    const urls = {}
    for (const i of ret.stdout.match(/remote\..*?\.url=.+/g) || []) {
      const b = i.replace(/remote\.(.*?)\.url=.+/g, '$1')
      const url = i.replace(/remote\..*?\.url=/g, '')
      urls[b] = hide ? url.replace(/\/\/([^@]+)@/, '//') : url
    }
    return urls
  }

  /**
   * 游离 HEAD 容错：仓库处于 detached HEAD 时 `git pull` 永远失败
   *
   * 实测有用户的仓库停在 detached HEAD（`git status` 显示 `## HEAD (no branch)`），
   * 他发 #更新 时 `git log` 看起来已经是新版、实际代码一行没变，排查半天。
   * 这里先按 origin/HEAD → master → main 的顺序切回分支再更新。
   * @returns true 可以继续更新；false 表示切分支失败（已回复原因）
   */
  async ensureBranch(plugin = '') {
    const head = String((await this.exec('git symbolic-ref --short -q HEAD', plugin)).stdout || '').trim()
    /** 正常在分支上，什么都不用做 */
    if (head) return true

    const remoteHead = String((await this.exec('git rev-parse --abbrev-ref origin/HEAD', plugin)).stdout || '').trim()
    const candidates = []
    if (remoteHead && !remoteHead.includes('HEAD')) candidates.push(remoteHead.replace(/^origin\//, ''))
    candidates.push('master', 'main')

    for (const branch of [...new Set(candidates)].filter(Boolean)) {
      const hasRef = async ref => !(await this.exec(`git show-ref --verify --quiet ${ref}`, plugin)).error
      /** 本地已有该分支就切过去（保留本地提交）；只有远端有就直接建分支跟踪它 */
      const cmd = (await hasRef(`refs/heads/${branch}`))
        ? `git checkout ${branch}`
        : (await hasRef(`refs/remotes/origin/${branch}`))
          ? `git checkout -B ${branch} origin/${branch}`
          : ''
      if (!cmd) continue

      const ret = await this.exec(cmd, plugin)
      if (ret.error) {
        await this.reply(
          `「${this.typeName}」处于游离 HEAD，自动切回 ${branch} 失败：\n${ret.stderr || ret.error.message}\n` +
            `本地若有未提交改动，先 git stash（或确认不要了）再重试`,
        )
        return false
      }
      Bot.makeLog(
        'mark',
        `${this.e?.logFnc || ''} 游离 HEAD → 已切回分支 ${branch}`,
        'Update',
      )
      if (!this.quiet) await this.reply(`检测到仓库处于游离 HEAD（git pull 会一直失败），已自动切回分支 ${branch}`)
      return true
    }

    await this.reply(
      `「${this.typeName}」处于游离 HEAD，且找不到可用分支（origin/HEAD、master、main 都没有），无法自动切回`,
    )
    return false
  }

  /** 更新一个仓库：plugin 为空表示框架本体 */
  async runUpdate(plugin = '') {
    if (!(await Bot.fsStat(path.join(plugin ? `plugins/${plugin}` : '.', '.git')))) {
      await this.reply(
        plugin ? `「${plugin}」不是 git 仓库（没有 .git），无法更新` : '当前目录不是 git 仓库，无法更新框架',
      )
      return false
    }
    this.typeName = plugin || 'JiuLi'

    /** 游离 HEAD 容错：否则 git pull 永远失败，用户还以为更新过了 */
    if (!(await this.ensureBranch(plugin))) return false

    let cmd = 'git pull'
    let type = '更新'
    if (this.e?.msg?.includes('强制')) {
      type = '强制更新'
      const remoteBranch = await this.getRemoteBranch(true, plugin)
      cmd = remoteBranch
        ? `git reset --hard ${remoteBranch} && git pull --rebase`
        : 'git fetch --all && git reset --hard origin/HEAD'
    }

    this.oldCommitId = await this.getCommitId(plugin)
    Bot.makeLog('mark', `${this.e?.logFnc || ''} 开始${type} ${this.typeName}`, 'Update')
    if (!this.quiet) await this.reply(`开始${type} ${this.typeName}`)

    const ret = await this.exec(cmd, plugin)
    if (ret.error && !(await this.gitErr(plugin, ret.stdout, ret.error.message))) {
      Bot.makeLog('mark', `${this.e?.logFnc || ''} ${type}失败 ${this.typeName}`, 'Update')
      return false
    }

    const time = await this.getTime(plugin)
    if (/Already up[ -]to[ -]date|已经是最新/.test(ret.stdout)) {
      if (!this.quiet) await this.reply(`${this.typeName} 已是最新\n最后更新时间：${time}`)
    } else {
      this.isUp = true
      if (/package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml/.test(ret.stdout)) this.isPkgUp = true
      await this.reply(`${this.typeName} 更新成功\n更新时间：${time}`)
      const log = await this.getLog(plugin)
      if (log) await this.reply(log)
    }
    /** 内核是编译产物（lib/core 不入库），框架拉取后必须重新编译，否则跑的还是旧内核 */
    if (!plugin && this.isUp) await this.build()
    Bot.makeLog('mark', `${this.e?.logFnc || ''} 最后更新时间：${time}`, 'Update')
    return true
  }

  /** 重新编译内核（仅框架本体更新后需要） */
  async build() {
    /**
     * release 分支是编译好的产物：没有 src/、也没有 devDependencies，既不需要也编译不了。
     * 这里直接视为成功，否则每次更新都会报「内核编译失败」。
     */
    const hasSrc = await fs
      .access(path.join(process.cwd(), 'src'))
      .then(() => true)
      .catch(() => false)
    if (!hasSrc) {
      Bot.makeLog('mark', '当前为已编译分支（无 src/），跳过内核编译', 'Update')
      return true
    }
    const ret = await this.exec('pnpm build', '')
    if (ret.error) {
      await this.reply(
        `内核编译失败，请手动执行 ${logger.red('pnpm build')}\n${Bot.String(ret.stderr || ret.error)}`,
      )
      return false
    }
    Bot.makeLog('mark', '内核已重新编译', 'Update')
    return true
  }

  /** 常见 git 错误的解释与下一步建议；返回 true 表示已在内部补救成功 */
  async gitErr(plugin, stdout, error) {
    const hint = plugin ? `#强制更新${plugin}` : '#强制更新'
    const url = error.match(/'(.+?)'/g)?.[0]?.replace(/'/g, '') || ''
    if (/unable to access|无法访问|Could not resolve|连接超时|Failed to connect/i.test(error))
      await this.reply(`远程仓库连接失败：${url || error}\n请检查网络或代理后重试`)
    else if (/not found|未找到|does not (exist|appear)|不存在|Authentication failed|鉴权失败/i.test(error))
      await this.reply(`远程仓库地址或凭据有误：${url || error}`)
    else if (/local changes|本地修改|be overwritten by merge|被合并操作覆盖/i.test(error))
      await this.reply(
        `「${plugin || 'JiuLi'}」有本地改动，git 拒绝覆盖：\n${stdout || ''}\n` +
          `确认不需要这些改动后发送 ${hint} 覆盖更新`,
      )
    else if (/Merge conflict|合并冲突/i.test(stdout))
      await this.reply(`${error}\n${stdout}\n若修改过文件请手动更新，否则发送 ${hint}`)
    else if (/divergent branches|偏离的分支|Need to specify how to reconcile/i.test(error)) {
      const ret = await this.exec('git pull --rebase', plugin)
      if (!ret.error && /Successfully rebased|成功变基/i.test(ret.stdout + ret.stderr)) return true
      await this.reply(`${error}\n${stdout}\n可发送 ${hint} 覆盖更新`)
    } else await this.reply(`${error}\n${stdout}\n未知错误，可尝试发送 ${hint}`)
    return false
  }

  async update() {
    if (!this.e?.isMaster) return false
    if (updating) return this.reply('正在更新，请稍候再试')

    /** rule 里带捕获组时 useHandler 会传参，这里统一按消息解析 */
    const plugin = await this.getPlugin()
    if (plugin === false) return false

    updating = true
    try {
      await this.runUpdate(plugin)
      if (this.isPkgUp) await this.updatePackage()
      if (this.isUp) this.restart()
    } finally {
      updating = false
    }
  }

  async updateAll() {
    if (!this.e?.isMaster) return false
    if (updating) return this.reply('正在更新，请稍候再试')

    updating = true
    try {
      await this.runUpdate()
      for (const dir of await fs.readdir('plugins').catch(() => [])) {
        /** 只更新 git 仓库，非仓库目录（system / demo / 自建目录）静默跳过 */
        if (!(await Bot.fsStat(path.join('plugins', dir, '.git')))) continue
        await this.runUpdate(dir).catch(err => Bot.makeLog('error', [`更新 ${dir} 失败`, err], 'Update'))
      }
      if (this.isPkgUp) await this.updatePackage()
      if (this.isUp) this.restart()
    } finally {
      updating = false
    }
  }

  async updatePackage() {
    await this.reply('开始更新依赖')
    const ret = await this.exec('pnpm install')
    if (ret.error) await this.reply(`依赖安装失败，请手动执行 pnpm install\n${Bot.String(ret.stderr)}`)
    return ret
  }

  /** 延迟一点再重启，保证上面的消息先发出去 */
  restart(delay = 2000) {
    if (!this.isUp) return
    setTimeout(() => new Restart(this.e).restart(), delay)
  }

  /** 提交日志：有 oldCommitId 时列出上次更新之后的提交（返回可转发的数组） */
  async getLog(plugin = '') {
    const ret = await this.exec('git log -100 --pretty="%h||[%cd] %s" --date=format:"%F %T"', plugin)
    if (ret.error) return '读取提交日志失败'

    /** 单独查看日志（没有更新基线）时只列最近 10 条 */
    const max = this.oldCommitId ? 100 : 10
    const log = []
    for (const str of ret.stdout.split('\n')) {
      const [id, msg] = str.split('||')
      if (!msg) continue
      if (this.oldCommitId && id === this.oldCommitId) break
      if (msg.includes('Merge branch')) continue
      log.push(msg)
      if (log.length >= max) break
    }
    if (!log.length) return ''

    const msg = [`${this.typeName} 更新日志，共 ${log.length} 条`, log.join('\n\n')]
    const url = await this.getRemoteUrl((await this.getRemoteBranch(false, plugin)).remote, true, plugin)
    if (typeof url === 'string' && url) msg.push(url)
    return Bot.makeForwardArray(msg)
  }

  async updateLog() {
    const plugin = await this.getPlugin()
    if (plugin === false) return false
    const log = await this.getLog(plugin)
    return this.reply(log || `${this.typeName} 暂无新的提交`)
  }
}

/** 兼容旧插件的具名导入：import { update } from '../../system/update.js' */
export { Update as update }
