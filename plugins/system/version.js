import fs from 'node:fs'
import { JiuLiPlugin, cfg } from 'jiuli'

/**
 * #版本
 * 显示框架版本、兼容目标、运行环境与 git 提交
 */
export default class Version extends JiuLiPlugin {
  constructor() {
    super({
      name: '版本',
      dsc: '#版本',
      event: 'message',
      priority: -Infinity,
      rule: [{ reg: '^#版本$', fnc: 'version' }],
    })
  }

  static realVersion() {
    try {
      return JSON.parse(fs.readFileSync('package.json', 'utf8')).version
    } catch {
      return '0.0.0'
    }
  }

  /** git 提交信息缓存（避免每次 #版本 都起一个 git 子进程） */
  static commitCache = { value: '', at: 0 }

  /** 直接读 .git 目录拿提交（比起 git 子进程快得多，读不到再回退） */
  readGitHead() {
    try {
      const head = fs.readFileSync('.git/HEAD', 'utf8').trim()
      let hash = head
      if (head.startsWith('ref:')) {
        const ref = head.slice(4).trim()
        try {
          hash = fs.readFileSync(`.git/${ref}`, 'utf8').trim()
        } catch {
          /** 可能已被打包进 packed-refs */
          const packed = fs.readFileSync('.git/packed-refs', 'utf8')
          const line = packed.split('\n').find(l => l.endsWith(` ${ref}`))
          hash = line ? line.split(' ')[0] : ''
        }
      }
      return hash ? hash.slice(0, 7) : ''
    } catch {
      return ''
    }
  }

  async gitCommit() {
    const now = Date.now()
    if (Version.commitCache.value && now - Version.commitCache.at < 300000) return Version.commitCache.value
    /** 优先直读 .git；读不到（如打包仓库）再回退到 git 命令 */
    let value = this.readGitHead()
    if (!value) {
      const ret = await Bot.exec('git log -1 --pretty=format:"%h %s"', { quiet: true })
      value = ret.error ? '' : ret.stdout
    }
    Version.commitCache = { value, at: now }
    return value
  }

  async init() {
    /** 后台预热，避免首次 #版本 卡在 git 子进程上 */
    this.gitCommit().catch(() => {})
  }

  async version() {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const commit = await this.gitCommit()
    const msg = [
      `JiuLi v${Version.realVersion()}`,
      `插件可见的框架标识：${cfg.frameworkName} v${cfg.frameworkVersion}（config/jiuli.yaml → compat）`,
      `Node：${process.version}  ${process.platform} ${process.arch}`,
      commit ? `提交：${commit}` : '',
      `许可：AGPL-3.0（基于 TRSS-Yunzai 重构）`,
      pkg.dependencies?.puppeteer ? `渲染：puppeteer ${pkg.dependencies.puppeteer}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    return this.reply(msg)
  }
}
